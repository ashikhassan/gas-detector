/**
 * AegisGas IoT Dashboard - Client Script
 * Handles real-time telemetry, interactive controls, live charts, and WhatsApp testing.
 */

document.addEventListener('DOMContentLoaded', () => {
  // Socket.io initialization
  const socket = io();

  // State
  let currentGasValue = 0;
  let currentThreshold = 2000;
  let isWebAudioEnabled = true;
  let audioContext = null;
  let isAlarmActive = false;
  let chartInstance = null;

  // DOM Elements
  const deviceStatusBadge = document.getElementById('deviceStatusBadge');
  const deviceStatusText = document.getElementById('deviceStatusText');
  const deviceIp = document.getElementById('deviceIp');
  const deviceRssi = document.getElementById('deviceRssi');

  const hazardBanner = document.getElementById('hazardBanner');
  const bannerGasVal = document.getElementById('bannerGasVal');
  const bannerThresholdVal = document.getElementById('bannerThresholdVal');
  const btnMuteAlarm = document.getElementById('btnMuteAlarm');

  const mainGasValue = document.getElementById('mainGasValue');
  const gasLevelTag = document.getElementById('gasLevelTag');
  const gaugeProgress = document.getElementById('gaugeProgress');

  const buzzerIndicator = document.getElementById('buzzerIndicator');
  const buzzerStateText = document.getElementById('buzzerStateText');
  const ledIndicator = document.getElementById('ledIndicator');
  const ledStateText = document.getElementById('ledStateText');
  const whatsappIndicator = document.getElementById('whatsappIndicator');
  const whatsappStatusText = document.getElementById('whatsappStatusText');

  const currentThresholdDisplay = document.getElementById('currentThresholdDisplay');
  const thresholdSlider = document.getElementById('thresholdSlider');
  const presetButtons = document.querySelectorAll('.btn-preset');

  const btnSimulateSafe = document.getElementById('btnSimulateSafe');
  const btnSimulateLeak = document.getElementById('btnSimulateLeak');
  const btnTestWhatsApp = document.getElementById('btnTestWhatsApp');
  const btnToggleAudio = document.getElementById('btnToggleAudio');
  const audioBtnText = document.getElementById('audioBtnText');
  const btnClearLogs = document.getElementById('btnClearLogs');
  const alertLogsBody = document.getElementById('alertLogsBody');

  // Settings Modal Elements
  const btnOpenSettings = document.getElementById('btnOpenSettings');
  const btnCloseSettings = document.getElementById('btnCloseSettings');
  const btnCancelSettings = document.getElementById('btnCancelSettings');
  const settingsModal = document.getElementById('settingsModal');
  const settingsForm = document.getElementById('settingsForm');
  const inputToken = document.getElementById('inputToken');
  const inputPhoneId = document.getElementById('inputPhoneId');
  const inputRecipient = document.getElementById('inputRecipient');
  const inputAlertTemplate = document.getElementById('inputAlertTemplate');
  const inputRecoveryTemplate = document.getElementById('inputRecoveryTemplate');
  const checkAutoWhatsapp = document.getElementById('checkAutoWhatsapp');
  const checkMuteBuzzer = document.getElementById('checkMuteBuzzer');
  const btnToggleToken = document.getElementById('btnToggleToken');
  const toastContainer = document.getElementById('toastContainer');

  // ==========================================
  // Web Audio Alarm Synthesizer (No external mp3 needed)
  // ==========================================
  let alarmInterval = null;

  function playBuzzerBeep() {
    if (!isWebAudioEnabled) return;
    try {
      if (!audioContext) {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
      }
      if (audioContext.state === 'suspended') {
        audioContext.resume();
      }

      const osc = audioContext.createOscillator();
      const gain = audioContext.createGain();

      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(880, audioContext.currentTime); // A5
      osc.frequency.exponentialRampToValueAtTime(440, audioContext.currentTime + 0.15);

      gain.gain.setValueAtTime(0.15, audioContext.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.15);

      osc.connect(gain);
      gain.connect(audioContext.destination);

      osc.start();
      osc.stop(audioContext.currentTime + 0.16);
    } catch (e) {
      console.warn('Audio playback error:', e);
    }
  }

  function startAudioAlarm() {
    if (!alarmInterval) {
      playBuzzerBeep();
      alarmInterval = setInterval(playBuzzerBeep, 400);
    }
  }

  function stopAudioAlarm() {
    if (alarmInterval) {
      clearInterval(alarmInterval);
      alarmInterval = null;
    }
  }

  // ==========================================
  // Initialize Chart.js
  // ==========================================
  function initChart() {
    const ctx = document.getElementById('gasChart').getContext('2d');

    const gradient = ctx.createLinearGradient(0, 0, 0, 240);
    gradient.addColorStop(0, 'rgba(6, 182, 212, 0.4)');
    gradient.addColorStop(1, 'rgba(6, 182, 212, 0.0)');

    chartInstance = new Chart(ctx, {
      type: 'line',
      data: {
        labels: [],
        datasets: [
          {
            label: 'Gas Reading',
            data: [],
            borderColor: '#06b6d4',
            backgroundColor: gradient,
            borderWidth: 2.5,
            tension: 0.35,
            fill: true,
            pointRadius: 2,
            pointHoverRadius: 5
          },
          {
            label: 'Threshold',
            data: [],
            borderColor: '#ef4444',
            borderWidth: 2,
            borderDash: [5, 5],
            fill: false,
            pointRadius: 0
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 300 },
        scales: {
          x: {
            grid: { color: 'rgba(255, 255, 255, 0.04)' },
            ticks: { color: '#6b7280', font: { family: 'JetBrains Mono', size: 10 }, maxRotation: 0 }
          },
          y: {
            min: 0,
            max: 4095,
            grid: { color: 'rgba(255, 255, 255, 0.06)' },
            ticks: { color: '#9ca3af', font: { family: 'JetBrains Mono', size: 10 } }
          }
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#1e293b',
            titleColor: '#06b6d4',
            bodyColor: '#f3f4f6',
            borderColor: 'rgba(255, 255, 255, 0.1)',
            borderWidth: 1,
            padding: 10
          }
        }
      }
    });
  }

  // ==========================================
  // Update Gauge & Visuals
  // ==========================================
  const CIRCLE_CIRCUMFERENCE = 515; // 2 * PI * 82

  function updateGauge(gasVal, threshold) {
    currentGasValue = gasVal;
    mainGasValue.textContent = gasVal;
    bannerGasVal.textContent = gasVal;
    bannerThresholdVal.textContent = threshold;

    // Normalize value to 0-4095
    const ratio = Math.min(Math.max(gasVal / 4095, 0), 1);
    const offset = CIRCLE_CIRCUMFERENCE - (ratio * CIRCLE_CIRCUMFERENCE);
    gaugeProgress.style.strokeDashoffset = offset;

    const isHazard = gasVal > threshold;
    const isWarning = gasVal > (threshold * 0.75);

    if (isHazard) {
      gasLevelTag.className = 'safety-tag hazard';
      gasLevelTag.textContent = 'CRITICAL HAZARD';
      gaugeProgress.style.stroke = 'var(--accent-rose)';
      hazardBanner.classList.remove('hidden');
      if (!isAlarmActive) {
        isAlarmActive = true;
        startAudioAlarm();
      }
    } else if (isWarning) {
      gasLevelTag.className = 'safety-tag warning';
      gasLevelTag.textContent = 'ELEVATED';
      gaugeProgress.style.stroke = 'var(--accent-amber)';
      hazardBanner.classList.add('hidden');
      isAlarmActive = false;
      stopAudioAlarm();
    } else {
      gasLevelTag.className = 'safety-tag safe';
      gasLevelTag.textContent = 'NORMAL';
      gaugeProgress.style.stroke = 'var(--accent-emerald)';
      hazardBanner.classList.add('hidden');
      isAlarmActive = false;
      stopAudioAlarm();
    }
  }

  function updateHardwareState(buzzer, led) {
    if (buzzer) {
      buzzerIndicator.className = 'hw-box active';
      buzzerStateText.textContent = 'BEEPING';
    } else {
      buzzerIndicator.className = 'hw-box inactive';
      buzzerStateText.textContent = 'OFF';
    }

    if (led) {
      ledIndicator.className = 'hw-box active';
      ledStateText.textContent = 'FLASHING';
    } else {
      ledIndicator.className = 'hw-box inactive';
      ledStateText.textContent = 'OFF';
    }
  }

  function updateDeviceStatus(status, ip, rssi) {
    deviceStatusBadge.className = `status-pill ${status}`;
    if (status === 'alarm') {
      deviceStatusText.textContent = 'ALARM TRIPPED';
    } else if (status === 'online') {
      deviceStatusText.textContent = 'ESP32 Connected';
    } else {
      deviceStatusText.textContent = 'ESP32 Offline';
    }

    if (ip && ip !== 'Unknown') deviceIp.textContent = ip;
    if (rssi) deviceRssi.textContent = `${rssi} dBm`;
  }

  // ==========================================
  // Alert Logs Rendering
  // ==========================================
  function renderAlertLogs(alerts) {
    if (!alerts || alerts.length === 0) {
      alertLogsBody.innerHTML = `
        <tr class="empty-row">
          <td colspan="6">No safety incidents recorded. System running normally.</td>
        </tr>
      `;
      return;
    }

    alertLogsBody.innerHTML = alerts.map(alt => {
      const isResolved = alt.status === 'resolved';
      const statusBadge = isResolved
        ? `<span class="log-status-badge resolved"><i class="fa-solid fa-check"></i> Resolved</span>`
        : `<span class="log-status-badge active"><i class="fa-solid fa-triangle-exclamation"></i> Active Leak</span>`;

      const startTime = alt.startTime ? new Date(alt.startTime).toLocaleTimeString() : '--';
      const duration = alt.durationSeconds ? `${alt.durationSeconds}s` : (isResolved ? 'Brief' : 'Ongoing...');
      const waSent = alt.whatsappAlertSent 
        ? `<span class="wa-status sent"><i class="fa-brands fa-whatsapp"></i> Dispatched</span>`
        : `<span class="wa-status failed"><i class="fa-solid fa-ban"></i> Not Sent</span>`;

      return `
        <tr>
          <td>${statusBadge}</td>
          <td><code>${alt.id || '--'}</code></td>
          <td>${startTime}</td>
          <td><strong>${alt.peakValue || '--'}</strong> ADC</td>
          <td>${duration}</td>
          <td>${waSent}</td>
        </tr>
      `;
    }).join('');
  }

  // ==========================================
  // Toast Helper
  // ==========================================
  function showToast(message, type = 'info', icon = 'fa-info-circle') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `<i class="fa-solid ${icon}"></i> <span>${message}</span>`;
    toastContainer.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(100%)';
      setTimeout(() => toast.remove(), 300);
    }, 4000);
  }

  // ==========================================
  // Socket.io Events
  // ==========================================
  socket.on('initial_state', (data) => {
    if (data.config) {
      currentThreshold = data.config.gasThreshold || 2000;
      thresholdSlider.value = currentThreshold;
      currentThresholdDisplay.textContent = currentThreshold;

      // Populate Settings Inputs
      inputToken.value = data.config.whatsappToken || '';
      inputPhoneId.value = data.config.phoneNumberId || '';
      inputRecipient.value = data.config.recipientPhone || '';
      inputAlertTemplate.value = data.config.alertTemplateName || 'gas_alert';
      inputRecoveryTemplate.value = data.config.recoveryTemplateName || 'gas_recovered';
      checkAutoWhatsapp.checked = Boolean(data.config.autoNotifyWhatsapp);
      checkMuteBuzzer.checked = Boolean(data.config.buzzerMuted);

      if (data.config.whatsappToken && data.config.phoneNumberId) {
        whatsappStatusText.textContent = 'Configured';
        whatsappIndicator.className = 'hw-box connected';
      }
    }

    if (data.device) {
      updateGauge(data.device.gasValue, currentThreshold);
      updateHardwareState(data.device.buzzerActive, data.device.ledActive);
      updateDeviceStatus(data.device.status, data.device.ip, data.device.rssi);
    }

    if (data.history && chartInstance) {
      chartInstance.data.labels = data.history.map(h => h.time);
      chartInstance.data.datasets[0].data = data.history.map(h => h.gasValue);
      chartInstance.data.datasets[1].data = data.history.map(() => currentThreshold);
      chartInstance.update('none');
    }

    if (data.alerts) {
      renderAlertLogs(data.alerts);
    }
  });

  socket.on('telemetry', (data) => {
    updateGauge(data.gasValue, data.threshold);
    updateHardwareState(data.buzzerActive, data.ledActive);
    updateDeviceStatus(data.status, data.ip, data.rssi);

    if (chartInstance && data.point) {
      chartInstance.data.labels.push(data.point.time);
      chartInstance.data.datasets[0].data.push(data.point.gasValue);
      chartInstance.data.datasets[1].data.push(data.threshold);

      if (chartInstance.data.labels.length > 30) {
        chartInstance.data.labels.shift();
        chartInstance.data.datasets[0].data.shift();
        chartInstance.data.datasets[1].data.shift();
      }
      chartInstance.update('none');
    }
  });

  socket.on('device_status_change', (data) => {
    updateDeviceStatus(data.status);
  });

  socket.on('config_updated', (cfg) => {
    if (cfg.gasThreshold) {
      currentThreshold = cfg.gasThreshold;
      thresholdSlider.value = currentThreshold;
      currentThresholdDisplay.textContent = currentThreshold;

      // Update preset buttons active state
      presetButtons.forEach(btn => {
        btn.classList.toggle('active', parseInt(btn.dataset.val) === currentThreshold);
      });

      if (chartInstance) {
        chartInstance.data.datasets[1].data = chartInstance.data.datasets[1].data.map(() => currentThreshold);
        chartInstance.update('none');
      }
    }
  });

  socket.on('new_alert', (alert) => {
    showToast(`🚨 Gas Leak Alert: Peak ${alert.peakValue} ADC`, 'error', 'fa-triangle-exclamation');
    fetchAlerts();
  });

  socket.on('alert_resolved', (alert) => {
    showToast(`✅ Gas Level Normalized (${alert.durationSeconds}s duration)`, 'success', 'fa-circle-check');
    fetchAlerts();
  });

  socket.on('whatsapp_dispatch', (data) => {
    if (data.success) {
      showToast(`WhatsApp ${data.type} template delivered!`, 'whatsapp', 'fa-whatsapp');
    } else {
      const errMsg = typeof data.result?.error === 'string' ? data.result.error : 'Meta API response error';
      showToast(`WhatsApp delivery failed: ${errMsg}`, 'error', 'fa-circle-xmark');
    }
  });

  // ==========================================
  // Controls Handlers
  // ==========================================

  // Threshold slider live drag
  thresholdSlider.addEventListener('input', (e) => {
    currentThresholdDisplay.textContent = e.target.value;
  });

  // Threshold slider committed change
  thresholdSlider.addEventListener('change', async (e) => {
    const val = parseInt(e.target.value, 10);
    await updateThresholdOnServer(val);
  });

  // Threshold preset buttons
  presetButtons.forEach(btn => {
    btn.addEventListener('click', async () => {
      const val = parseInt(btn.dataset.val, 10);
      thresholdSlider.value = val;
      currentThresholdDisplay.textContent = val;
      await updateThresholdOnServer(val);
    });
  });

  async function updateThresholdOnServer(val) {
    try {
      const res = await fetch('/api/config/threshold', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threshold: val })
      });
      const data = await res.json();
      if (data.success) {
        showToast(`Threshold set to ${val} ADC`, 'success', 'fa-check');
      }
    } catch (err) {
      showToast('Failed to update threshold', 'error', 'fa-xmark');
    }
  }

  // Simulation Tools
  btnSimulateSafe.addEventListener('click', async () => {
    await fetch('/api/simulate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gasValue: 850 })
    });
    showToast('Simulated Normal Air (850 ADC)', 'success', 'fa-leaf');
  });

  btnSimulateLeak.addEventListener('click', async () => {
    await fetch('/api/simulate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gasValue: 2600 })
    });
    showToast('Simulated Gas Hazard (2600 ADC)', 'error', 'fa-fire-flame-curved');
  });

  // Test WhatsApp Alert Button
  btnTestWhatsApp.addEventListener('click', async () => {
    showToast('Sending test WhatsApp message to Meta Cloud API...', 'info', 'fa-paper-plane');
    try {
      const res = await fetch('/api/whatsapp/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          templateName: inputAlertTemplate.value || 'gas_alert',
          gasValue: currentGasValue || 2450
        })
      });
      const result = await res.json();
      if (result.success) {
        showToast('Meta Cloud API accepted WhatsApp message!', 'whatsapp', 'fa-whatsapp');
      } else {
        const errorDetail = typeof result.error === 'object' ? JSON.stringify(result.error) : result.error;
        showToast(`Meta WhatsApp Error: ${errorDetail}`, 'error', 'fa-triangle-exclamation');
      }
    } catch (err) {
      showToast('Network error testing WhatsApp', 'error', 'fa-xmark');
    }
  });

  // Mute Alarm Audio
  btnMuteAlarm.addEventListener('click', () => {
    stopAudioAlarm();
    showToast('Alarm sound muted for this session', 'info', 'fa-volume-xmark');
  });

  // Toggle Web Audio
  btnToggleAudio.addEventListener('click', () => {
    isWebAudioEnabled = !isWebAudioEnabled;
    audioBtnText.textContent = `Web Audio: ${isWebAudioEnabled ? 'ON' : 'OFF'}`;
    if (!isWebAudioEnabled) stopAudioAlarm();
    showToast(`Dashboard Web Audio ${isWebAudioEnabled ? 'Enabled' : 'Disabled'}`, 'info', 'fa-volume-high');
  });

  // Clear Alert Logs
  btnClearLogs.addEventListener('click', async () => {
    await fetch('/api/alerts', { method: 'DELETE' });
    renderAlertLogs([]);
    showToast('Alert logs cleared', 'info', 'fa-trash');
  });

  async function fetchAlerts() {
    try {
      const res = await fetch('/api/alerts');
      const data = await res.json();
      renderAlertLogs(data.alerts);
    } catch (e) {
      console.warn('Error fetching alerts:', e);
    }
  }

  // ==========================================
  // Settings Modal Handlers
  // ==========================================
  btnOpenSettings.addEventListener('click', () => {
    settingsModal.classList.remove('hidden');
  });

  btnCloseSettings.addEventListener('click', () => {
    settingsModal.classList.add('hidden');
  });

  btnCancelSettings.addEventListener('click', () => {
    settingsModal.classList.add('hidden');
  });

  btnToggleToken.addEventListener('click', () => {
    const isPassword = inputToken.type === 'password';
    inputToken.type = isPassword ? 'text' : 'password';
    btnToggleToken.innerHTML = isPassword ? '<i class="fa-solid fa-eye-slash"></i>' : '<i class="fa-solid fa-eye"></i>';
  });

  settingsForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    const payload = {
      whatsappToken: inputToken.value,
      phoneNumberId: inputPhoneId.value,
      recipientPhone: inputRecipient.value,
      alertTemplateName: inputAlertTemplate.value,
      recoveryTemplateName: inputRecoveryTemplate.value,
      autoNotifyWhatsapp: checkAutoWhatsapp.checked,
      buzzerMuted: checkMuteBuzzer.checked
    };

    try {
      const res = await fetch('/api/config/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();

      if (data.success) {
        showToast('Settings saved successfully!', 'success', 'fa-check');
        settingsModal.classList.add('hidden');
      } else {
        showToast('Failed to save settings', 'error', 'fa-xmark');
      }
    } catch (err) {
      showToast('Network error saving settings', 'error', 'fa-xmark');
    }
  });

  // Start chart on load
  initChart();
});
