const request = require('supertest');
jest.mock('axios');
const axios = require('axios');

let app, serverInstance;

beforeAll(() => {
  process.env.NODE_ENV = 'test';
  ({ app, serverInstance } = require('../index'));
});

afterAll((done) => {
  serverInstance.close(done);
});

function mockLoginSequence() {
  axios.post.mockImplementationOnce(async () => ({ data: { accessToken: 'tokenA', refreshToken: 'refreshA', expiresIn: 60 } }));
}

describe('API integration (mocked Easee)', () => {
  test('login, list chargers, state, sessions 24h', async () => {
    mockLoginSequence();

    const agent = request.agent(app);
    // login
    const loginRes = await agent.post('/api/login').send({ username: 'u', password: 'p' });
    expect(loginRes.status).toBe(200);

    // mock chargers
    axios.create = () => ({
      get: async (url) => {
        if (url === '/api/chargers') return { data: [{ id: 'EH123', name: 'Home' }] };
        if (url.includes('/state')) return { data: { outputCurrent: 10, dynamicChargerCurrent: 16, cableRating: 32, voltage: 230, lifetimeEnergy: 123.45, sessionEnergy: 1.23, totalPower: 6.9 } };
        if (url.includes('/sessions/ongoing')) return { data: { startTime: new Date(Date.now()-3600*1000).toISOString(), kwh: 1.5 } };
        throw new Error('Unexpected GET ' + url);
      }
    });

    const chargers = await agent.get('/api/chargers');
    expect(chargers.status).toBe(200);
    expect(Array.isArray(chargers.body)).toBe(true);

    const state = await agent.get('/api/state').query({ chargerId: 'EH123' });
    expect(state.status).toBe(200);
    expect(state.body.outputCurrent).toBe(10);

    // sessions 24h
    axios.create = () => ({
      get: async (url, opts) => {
        if (url.includes('/sessions')) return { data: [{ kwh: 1.1 }, { kwh: 2.2 }, { kwh: 3.3 }] };
        return { data: {} };
      }
    });
    const sessions = await agent.get('/api/sessions-24h').query({ chargerId: 'EH123' });
    expect(sessions.status).toBe(200);
    expect(sessions.body.totalKwh).toBeCloseTo(6.6, 3);
  });

  test('auto refresh on 401', async () => {
    mockLoginSequence();
    const agent = request.agent(app);
    await agent.post('/api/login').send({ username: 'u', password: 'p' });

    // first call returns 401, then refresh token endpoint returns new token, retry succeeds
    axios.post.mockImplementationOnce(async () => ({ data: { accessToken: 'tokenB', refreshToken: 'refreshB', expiresIn: 60 } }));

    let first = true;
    axios.create = () => ({
      get: async (url) => {
        if (url.includes('/state')) {
          if (first) { first = false; const err = new Error('unauthorized'); err.response = { status: 401, data: 'Unauthorized' }; throw err; }
          return { data: { outputCurrent: 5 } };
        }
        return { data: [] };
      }
    });

    const res = await agent.get('/api/state').query({ chargerId: 'EH123' });
    expect(res.status).toBe(200);
    expect(res.body.outputCurrent).toBe(5);
  });
});

