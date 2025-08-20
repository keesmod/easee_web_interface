// Elements
const loginForm = document.getElementById('login-form');
const usernameInput = document.getElementById('username');
const passwordInput = document.getElementById('password');
const logoutBtn = document.getElementById('logout');
const loginBtn = document.querySelector('#login-form button[type="submit"]');

const loginSection = document.getElementById('login-section');
const dashboardSection = document.getElementById('dashboard');

const chargerSelect = document.getElementById('chargerSelect');
const chargerIdInput = document.getElementById('chargerId');

const currentSlider = document.getElementById('currentSlider');
const currentValueEl = document.getElementById('currentValue');
const applyCurrentBtn = document.getElementById('applyCurrentBtn');
const pauseBtn = document.getElementById('pauseBtn');
const resumeBtn = document.getElementById('resumeBtn');

const powerDisplay = document.getElementById('powerDisplay');
const sessionTimeEl = document.getElementById('sessionTime');
const sessionEnergyEl = document.getElementById('sessionEnergy');
const sessionCostEl = document.getElementById('sessionCost');
const totalEnergyEl = document.getElementById('totalEnergy');

const liveDataEl = document.getElementById('liveData');
const historyDataEl = document.getElementById('historyData');
const loginMessage = document.getElementById('login-message');

// Chart
let liveChart;
let liveTimer = null;
let eventSource = null;
let useSSE = true;
let userPrefs = { theme: 'dark', units: 'metric', currency: 'EUR', liveTransport: 'sse' };
let historyChart;

// basic visibility that the script loaded
console.log('[easee-ui] script loaded');
window.addEventListener('error', (e) => {
	console.error('[easee-ui] window error', e?.error || e?.message || e);
});

function showDashboard(isLoggedIn) {
	loginSection.classList.toggle('hidden', isLoggedIn);
	dashboardSection.classList.toggle('hidden', !isLoggedIn);
	logoutBtn.classList.toggle('hidden', !isLoggedIn);
}

function getChargerId() {
	const fromSelect = (chargerSelect?.value || '').trim();
	const fromInput = (chargerIdInput?.value || '').trim();
	return fromSelect || fromInput || '';
}

async function api(path, opts) {
	const res = await fetch(path, {
		method: opts?.method || 'GET',
		headers: { 'Content-Type': 'application/json' },
		credentials: 'same-origin',
		body: opts?.body ? JSON.stringify(opts.body) : undefined
	});
	if (!res.ok) {
		let msg = 'Request failed';
		try { const d = await res.json(); msg = d.error || JSON.stringify(d); } catch {}
		throw new Error(msg);
	}
	return res.json();
}

function initChart() {
	const ctx = document.getElementById('liveChart');
	if (!ctx) return;
	liveChart = new Chart(ctx, {
		type: 'line',
		data: {
			labels: [],
			datasets: [
				{
					label: 'Actual current (A)',
					data: [],
					borderColor: '#38bdf8',
					backgroundColor: 'rgba(56,189,248,0.15)',
					tension: 0.3,
					pointRadius: 0
				},
				{
					label: 'Allowed current (A)',
					data: [],
					borderColor: '#f59e0b',
					backgroundColor: 'rgba(245,158,11,0.15)',
					tension: 0.3,
					pointRadius: 0
				},
				{
					label: 'Station max (A)',
					data: [],
					borderColor: '#8b5cf6',
					backgroundColor: 'rgba(139,92,246,0.15)',
					tension: 0.3,
					pointRadius: 0
				}
			]
		},
		options: {
			animation: false,
			responsive: true,
			scales: {
				y: { beginAtZero: true, title: { display: true, text: 'Amps' } },
				x: { display: false }
			},
			plugins: { legend: { labels: { color: '#cbd5e1' } } }
		}
	});
}

function initHistoryChart() {
	const ctx = document.getElementById('historyChart');
	if (!ctx) return;
	if (historyChart) { historyChart.destroy(); }
	historyChart = new Chart(ctx, {
		type: 'bar',
		data: { labels: [], datasets: [{ label: 'Energy (kWh)', data: [], backgroundColor: '#22c55e' }] },
		options: { responsive: true, plugins: { legend: { labels: { color: '#cbd5e1' } } }, scales: { x: { ticks: { color: '#cbd5e1' } }, y: { ticks: { color: '#cbd5e1' } } } }
	});
}

function pushLivePoints(outputA, allowedA, maxA) {
	if (!liveChart) return;
	const ts = new Date();
	const label = ts.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
	liveChart.data.labels.push(label);
	liveChart.data.datasets[0].data.push(outputA);
	liveChart.data.datasets[1].data.push(allowedA);
	liveChart.data.datasets[2].data.push(maxA);
	// keep last 60 points (~5 minutes at 5s interval)
	const maxPoints = 60;
	for (const arr of [liveChart.data.labels, liveChart.data.datasets[0].data, liveChart.data.datasets[1].data, liveChart.data.datasets[2].data]) {
		while (arr.length > maxPoints) arr.shift();
	}
	liveChart.update('none');
}

async function handleLogin(e){
	e?.preventDefault?.();
	loginMessage.textContent='';
	try{
		await api('/api/login',{method:'POST',body:{username:usernameInput.value.trim(),password:passwordInput.value}});
		showDashboard(true);
		await loadChargers();
		// Auto-select charger: if exactly one, select it; if multiple, select first
		try {
			if (chargerSelect && chargerSelect.options && chargerSelect.options.length >= 2) {
				chargerSelect.selectedIndex = 1;
			}
		} catch {}
		initChart();
		initHistoryChart();
		loadPreferences();
		startLive();
		loginMessage.textContent='Logged in.';
	}catch(err){
		loginMessage.textContent=err.message;
	}
}

loginForm.addEventListener('submit', handleLogin);
loginBtn?.addEventListener('click', (e) => { e.preventDefault(); handleLogin(e); });

logoutBtn.addEventListener('click', async () => {
	try { await api('/api/logout', { method: 'POST' }); } catch {}
	showDashboard(false);
	if (liveTimer) { clearInterval(liveTimer); liveTimer = null; }
	if (eventSource) { eventSource.close(); eventSource = null; }
	if (liveChart) { liveChart.destroy(); liveChart = null; }
});

currentSlider?.addEventListener('input', () => {
	if (currentValueEl) currentValueEl.textContent = String(currentSlider.value);
});
if (currentValueEl && currentSlider) currentValueEl.textContent = String(currentSlider.value);

applyCurrentBtn?.addEventListener('click', async () => {
	const chargerId = getChargerId();
	if (!chargerId) return;
	const current = Number(currentSlider.value);
	try {
		await api('/api/set-current', { method: 'POST', body: { chargerId, current } });
		// feedback is implicit via live chart/state
	} catch (err) {
		alert(err.message);
	}
});

pauseBtn?.addEventListener('click', async () => {
	const chargerId = getChargerId();
	if (!chargerId) return;
	try {
		await api('/api/pause', { method: 'POST', body: { chargerId } });
	} catch (err) { alert(err.message); }
});

resumeBtn?.addEventListener('click', async () => {
	const chargerId = getChargerId();
	if (!chargerId) return;
	try {
		await api('/api/resume', { method: 'POST', body: { chargerId } });
	} catch (err) { alert(err.message); }
});

async function loadLive() {
	const chargerId = getChargerId();
	if (!chargerId) return;
	try {
		const data = await api(`/api/state?chargerId=${encodeURIComponent(chargerId)}`);
		// Update raw JSON
		if (liveDataEl) liveDataEl.textContent = JSON.stringify(data, null, 2);

		// Compute power (kW)
		const outputA = Number(data.outputCurrent || 0);
		const allowedA = Number(data.dynamicChargerCurrent || 0);
		const maxA = Number(data.cableRating || 0);
		const voltage = Number(data.voltage || 230);
		const phases = (data.dynamicCircuitCurrentP2 != null && data.dynamicCircuitCurrentP3 != null) ? 3 : 1;
		const kW = Number(data.totalPower || ((outputA * voltage * phases) / 1000));
		if (powerDisplay && Number.isFinite(kW)) powerDisplay.textContent = kW.toFixed(2);
		const phaseModeEl = document.getElementById('phaseMode');
		if (phaseModeEl) phaseModeEl.textContent = phases === 3 ? 'Three‑phase' : 'Single‑phase';
		if (currentValueEl && Number.isFinite(allowedA)) currentValueEl.textContent = String(currentSlider?.value || allowedA);

		if (totalEnergyEl && data.lifetimeEnergy != null) totalEnergyEl.textContent = `${Number(data.lifetimeEnergy).toFixed(2)} kWh`;
		if (sessionEnergyEl && data.sessionEnergy != null) sessionEnergyEl.textContent = `${Number(data.sessionEnergy).toFixed(2)} kWh`;

		pushLivePoints(outputA, allowedA, maxA);
	} catch (err) {
		if (liveDataEl) liveDataEl.textContent = err.message;
	}
}

function startLivePolling() {
	if (liveTimer) clearInterval(liveTimer);
	const tick = () => {
		const id = getChargerId();
		if (!id) return; // wait until user picks a charger
		loadLive();
		// session endpoint can be rate limited; poll it less frequently
		if (!tick._lastSession || Date.now() - tick._lastSession > 15000) {
			loadSession();
			tick._lastSession = Date.now();
		}
		// history is heavier; throttle to once per minute
		if (!tick._lastHistory || Date.now() - tick._lastHistory > 60000) {
			loadHistory();
			tick._lastHistory = Date.now();
		}
	};
	tick();
	liveTimer = setInterval(tick, 5000);
}

function startSSE() {
	if (eventSource) { eventSource.close(); eventSource = null; }
	const id = getChargerId();
	if (!id) return;
	const url = `/api/stream?chargerId=${encodeURIComponent(id)}`;
	const es = new EventSource(url, { withCredentials: true });
	es.addEventListener('state', (e) => {
		try { const data = JSON.parse(e.data); updateStateFromData(data); } catch {}
	});
	es.addEventListener('session', (e) => {
		try { const s = JSON.parse(e.data); updateSessionFromData(s); } catch {}
	});
	es.addEventListener('history', (e) => {
		try { const h = JSON.parse(e.data); updateHistoryFromData(h); } catch {}
	});
	es.addEventListener('error', (e) => {
		console.warn('SSE error', e);
	});
	es.addEventListener('ping', () => {});
	es.onerror = () => {
		// fallback to polling
		useSSE = false;
		savePreferences();
		startLivePolling();
		es.close();
	};
	eventSource = es;
}

function updateStateFromData(data){
	if (!data) return;
	if (liveDataEl) liveDataEl.textContent = JSON.stringify(data, null, 2);
	const outputA = Number(data.outputCurrent || 0);
	const allowedA = Number(data.dynamicChargerCurrent || 0);
	const maxA = Number(data.cableRating || 0);
	const voltage = Number(data.voltage || 230);
	const phases = (data.dynamicCircuitCurrentP2 != null && data.dynamicCircuitCurrentP3 != null) ? 3 : 1;
	const kW = Number(data.totalPower || ((outputA * voltage * phases) / 1000));
	if (powerDisplay && Number.isFinite(kW)) powerDisplay.textContent = kW.toFixed(2);
	const phaseModeEl = document.getElementById('phaseMode');
	if (phaseModeEl) phaseModeEl.textContent = phases === 3 ? 'Three‑phase' : 'Single‑phase';
	if (currentValueEl && Number.isFinite(allowedA)) currentValueEl.textContent = String(currentSlider?.value || allowedA);
	if (totalEnergyEl && data.lifetimeEnergy != null) totalEnergyEl.textContent = `${Number(data.lifetimeEnergy).toFixed(2)} kWh`;
	if (sessionEnergyEl && data.sessionEnergy != null) sessionEnergyEl.textContent = `${Number(data.sessionEnergy).toFixed(2)} kWh`;
	pushLivePoints(outputA, allowedA, maxA);
}

function updateSessionFromData(s){
	if (!s) {
		if (sessionTimeEl) sessionTimeEl.textContent = '—';
		if (sessionEnergyEl) sessionEnergyEl.textContent = '— kWh';
		if (sessionCostEl) sessionCostEl.textContent = '—';
		return;
	}
	const started = s.startTime || s.started || s.start;
	const energy = Number(s.kwh ?? s.energy ?? s.totalEnergy ?? 0);
	const cost = s.cost ?? s.totalCost ?? null;
	const durationMs = started ? (Date.now() - new Date(started).getTime()) : null;
	const duration = durationMs ? msToHMS(durationMs) : '—';
	if (sessionTimeEl) sessionTimeEl.textContent = duration;
	if (sessionEnergyEl) sessionEnergyEl.textContent = `${energy.toFixed(2)} kWh`;
	if (sessionCostEl) sessionCostEl.textContent = cost != null ? `${cost}` : '—';
}

function updateHistoryFromData(h){
	if (!h) return;
	try {
		const labels = h.sessions.map((s, i) => s.startTime?.slice(11,16) || `#${i+1}`);
		const data = h.sessions.map((s) => Number(s.kwh ?? s.energy ?? s.totalEnergy ?? 0));
		if (historyChart) {
			historyChart.data.labels = labels;
			historyChart.data.datasets[0].data = data;
			historyChart.update();
		}
	} catch {}
	if (historyDataEl) {
		historyDataEl.innerHTML = `
			<div class="text-sm text-slate-300">${h.from} → ${h.to}</div>
			<div class="mt-1 text-lg">Total: <span class="font-semibold">${h.totalKwh.toFixed(3)} kWh</span> across ${h.sessionsCount} sessions</div>
		`;
	}
}

function startLive(){
	useSSE = (userPrefs.liveTransport || 'sse') === 'sse';
	if (useSSE && window.EventSource) startSSE(); else startLivePolling();
}

async function loadSession() {
	const chargerId = getChargerId();
	if (!chargerId) return;
	try {
		const s = await api(`/api/session?chargerId=${encodeURIComponent(chargerId)}`);
		if (!s) {
			if (sessionTimeEl) sessionTimeEl.textContent = '—';
			if (sessionEnergyEl) sessionEnergyEl.textContent = '— kWh';
			if (sessionCostEl) sessionCostEl.textContent = '—';
			return;
		}
		const started = s.startTime || s.started || s.start;
		const energy = Number(s.kwh ?? s.energy ?? s.totalEnergy ?? 0);
		const cost = s.cost ?? s.totalCost ?? null;
		const durationMs = started ? (Date.now() - new Date(started).getTime()) : null;
		const duration = durationMs ? msToHMS(durationMs) : '—';
		if (sessionTimeEl) sessionTimeEl.textContent = duration;
		if (sessionEnergyEl) sessionEnergyEl.textContent = `${energy.toFixed(2)} kWh`;
		if (sessionCostEl) sessionCostEl.textContent = cost != null ? `${cost}` : '—';
	} catch (err) {
		// Non-fatal
	}
}

async function loadHistory() {
	const chargerId = getChargerId();
	if (!chargerId) return;
	try {
		const h = await api(`/api/sessions-24h?chargerId=${encodeURIComponent(chargerId)}`);
		if (historyDataEl) {
			historyDataEl.innerHTML = `
				<div class="text-sm text-slate-300">${h.from} → ${h.to}</div>
				<div class="mt-1 text-lg">Total: <span class="font-semibold">${h.totalKwh.toFixed(3)} kWh</span> across ${h.sessionsCount} sessions</div>
			`;
		}
	} catch (_err) {
		if (historyDataEl) historyDataEl.textContent = 'No data for last 24 hours.';
	}
}

function msToHMS(ms) {
	const totalSec = Math.floor(ms / 1000);
	const h = Math.floor(totalSec / 3600).toString().padStart(2, '0');
	const m = Math.floor((totalSec % 3600) / 60).toString().padStart(2, '0');
	const s = (totalSec % 60).toString().padStart(2, '0');
	return `${h}:${m}:${s}`;
}

async function loadChargers() {
	try {
		const chargers = await api('/api/chargers');
		if (!chargerSelect) return;
		while (chargerSelect.firstChild) chargerSelect.removeChild(chargerSelect.firstChild);
		const placeholder = document.createElement('option');
		placeholder.value = '';
		placeholder.textContent = 'Select your charger…';
		chargerSelect.appendChild(placeholder);
		chargers.forEach(c => {
			const opt = document.createElement('option');
			opt.value = c.id || c.chargerId || c.serial || '';
			const name = c.name || (c.site && c.site.name) || 'Unnamed';
			opt.textContent = `${name} (${opt.value})`;
			chargerSelect.appendChild(opt);
		});
		// Auto-select logic when list arrives
		if (chargerSelect.options.length >= 2) {
			chargerSelect.selectedIndex = 1;
			startLive();
		}
	} catch (e) {
		console.warn('Failed to load chargers', e);
	}
}

chargerSelect?.addEventListener('change', () => {
	if (eventSource) { eventSource.close(); eventSource = null; }
	startLive();
});

// Overview: fetch all chargers and basic state
const loadOverviewBtn = document.getElementById('loadOverviewBtn');
const overviewGrid = document.getElementById('overviewGrid');
loadOverviewBtn?.addEventListener('click', async () => {
	try {
		const chargers = await api('/api/chargers');
		overviewGrid.innerHTML = '';
		for (const c of chargers) {
			const id = c.id || c.chargerId || c.serial;
			if (!id) continue;
			let state = null;
			try { state = await api(`/api/state?chargerId=${encodeURIComponent(id)}`); } catch {}
			const kW = (state && Number(state.totalPower)) ? Number(state.totalPower) : 0;
			const card = document.createElement('div');
			card.className = 'rounded-xl bg-slate-800/60 border border-white/10 p-4';
			card.innerHTML = `<div class="font-semibold">${c.name || 'Unnamed'} (${id})</div><div class="text-sm text-slate-300">Power: ${kW.toFixed(2)} kW</div>`;
			overviewGrid.appendChild(card);
		}
	} catch (e) {
		overviewGrid.textContent = 'Failed to load overview';
	}
});

// Preferences: theme/units/currency/transport
function savePreferences(){
	try { localStorage.setItem('easee_prefs', JSON.stringify(userPrefs)); } catch {}
}
function loadPreferences(){
	try {
		const raw = localStorage.getItem('easee_prefs');
		if (raw) userPrefs = { ...userPrefs, ...JSON.parse(raw) };
		if (!userPrefs.currency) userPrefs.currency = 'EUR';
		if (!userPrefs.units) userPrefs.units = 'metric';
		applyTheme(userPrefs.theme);
	} catch {}
}
function applyTheme(theme){
	const body = document.body;
	if (!body) return;
	if (theme === 'light') {
		body.classList.remove('from-slate-900','to-slate-950','text-slate-50');
		body.classList.add('from-white','to-slate-100','text-slate-900');
	} else {
		body.classList.add('from-slate-900','to-slate-950','text-slate-50');
		body.classList.remove('from-white','to-slate-100','text-slate-900');
	}
}

// Wire header selects to userPrefs
window.applyTheme = applyTheme;
const themeSelectEl = document.getElementById('themeSelect');
const transportSelectEl = document.getElementById('transportSelect');
const unitsSelectEl = document.getElementById('unitsSelect');
const currencySelectEl = document.getElementById('currencySelect');
themeSelectEl?.addEventListener('change', () => { userPrefs.theme = themeSelectEl.value; savePreferences(); applyTheme(userPrefs.theme); });
transportSelectEl?.addEventListener('change', () => { userPrefs.liveTransport = transportSelectEl.value; savePreferences(); if (eventSource) { eventSource.close(); eventSource = null; } startLive(); });
unitsSelectEl?.addEventListener('change', () => { userPrefs.units = unitsSelectEl.value; savePreferences(); });
currencySelectEl?.addEventListener('change', () => { userPrefs.currency = currencySelectEl.value; savePreferences(); });

// Past sessions explorer UI
const pastFromEl = document.getElementById('pastFrom');
const pastToEl = document.getElementById('pastTo');
const pastBtn = document.getElementById('loadPastSessions');
const pastContainer = document.getElementById('pastSessionsContainer');

function toLocalDateTimeInputValue(d){
	const pad = (n) => String(n).padStart(2,'0');
	const yyyy = d.getFullYear();
	const mm = pad(d.getMonth()+1);
	const dd = pad(d.getDate());
	const hh = pad(d.getHours());
	const mi = pad(d.getMinutes());
	return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
}

// Prefill defaults: last 7 days
if (pastFromEl && pastToEl) {
	const to = new Date();
	const from = new Date(to.getTime() - 7*24*60*60*1000);
	pastFromEl.value = toLocalDateTimeInputValue(from);
	pastToEl.value = toLocalDateTimeInputValue(to);
}

pastBtn?.addEventListener('click', async () => {
	const chargerId = getChargerId();
	if (!chargerId) return;
	const from = pastFromEl?.value ? new Date(pastFromEl.value).toISOString() : null;
	const to = pastToEl?.value ? new Date(pastToEl.value).toISOString() : null;
	if (!from || !to) return;
	pastContainer.textContent = 'Loading…';
	try {
		const resp = await api(`/api/sessions-range?chargerId=${encodeURIComponent(chargerId)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
		const rows = resp.sessions.map((s,i)=>{
			const started = s.startTime || s.started || s.start || s.start_time || '';
			const ended = s.endTime || s.ended || s.end || s.end_time || '';
			const kwh = Number(s.kwh ?? s.energy ?? s.totalEnergy ?? s.total_kwh ?? 0).toFixed(3);
			return `<tr class="border-b border-white/5">
				<td class="py-1 pr-3 whitespace-nowrap">${i+1}</td>
				<td class="py-1 pr-3">${started ? new Date(started).toLocaleString() : '—'}</td>
				<td class="py-1 pr-3">${ended ? new Date(ended).toLocaleString() : '—'}</td>
				<td class="py-1 pr-3 text-right">${kwh} kWh</td>
			</tr>`;
		}).join('');
		pastContainer.innerHTML = `
			<div class="text-sm text-slate-300">${resp.from} → ${resp.to}</div>
			<div class="mt-1">Total: <span class="font-semibold">${resp.totalKwh.toFixed(3)} kWh</span> across ${resp.sessionsCount} sessions</div>
			<div class="overflow-x-auto mt-3">
				<table class="min-w-full text-sm">
					<thead class="text-slate-300">
						<tr><th class="text-left pr-3">#</th><th class="text-left pr-3">Start</th><th class="text-left pr-3">End</th><th class="text-right">Energy</th></tr>
					</thead>
					<tbody>${rows || '<tr><td class="py-2" colspan="4">No sessions</td></tr>'}</tbody>
				</table>
			</div>`;
	} catch (e) {
		pastContainer.textContent = (e && e.message) ? e.message : 'Failed to load sessions';
	}
});
