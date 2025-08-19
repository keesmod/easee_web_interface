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
		initChart();
		startLivePolling();
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
		loadSession();
		loadHistory();
	};
	tick();
	liveTimer = setInterval(tick, 5000);
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
	} catch (err) {
		if (historyDataEl) historyDataEl.textContent = err.message;
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
	} catch (e) {
		console.warn('Failed to load chargers', e);
	}
}

chargerSelect?.addEventListener('change', () => {
	startLivePolling();
});



