// ========== State ==========
const STATE_WORK = 'work';
const STATE_SHORT_BREAK = 'shortBreak';
const STATE_LONG_BREAK = 'longBreak';
const STATE_IDLE = 'idle';

let state = {
  timerState: STATE_IDLE,
  timeLeft: 25 * 60,
  totalTime: 25 * 60,
  isRunning: false,
  completedPomos: 0,
  currentTaskId: null,
  // Settings
  workDuration: 25,
  shortBreakDuration: 5,
  longBreakDuration: 15,
  longBreakInterval: 4,
  soundEnabled: true,
  // Tasks
  tasks: [],
  // Stats: { 'YYYY-MM-DD': count }
  stats: {}
};

let timerInterval = null;
let audioCtx = null;
const CIRCUMFERENCE = 2 * Math.PI * 90;

// ========== DOM Cache ==========
const $ = (id) => document.getElementById(id);
const els = {
  timerTime: $('timerTime'),
  sessionLabel: $('sessionLabel'),
  ringProgress: $('ringProgress'),
  statusBadge: $('statusBadge'),
  btnStart: $('btnStart'),
  btnPause: $('btnPause'),
  taskList: $('taskList'),
  taskEmpty: $('taskEmpty'),
  taskInput: $('taskInput'),
  statToday: $('statToday'),
  statWeek: $('statWeek'),
  statTotal: $('statTotal'),
  statHours: $('statHours'),
  chartBars: $('chartBars'),
  settingWork: $('settingWork'),
  settingShortBreak: $('settingShortBreak'),
  settingLongBreak: $('settingLongBreak'),
  settingInterval: $('settingInterval'),
  settingSound: $('settingSound')
};

// ========== Utilities ==========
function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

function getDateString(date) {
  const d = date || new Date();
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

function getMonday(now) {
  const d = new Date(now);
  const dow = d.getDay();
  d.setDate(d.getDate() - (dow === 0 ? 6 : dow - 1));
  d.setHours(0, 0, 0, 0);
  return d;
}

// ========== Storage ==========
function loadData() {
  try {
    const saved = localStorage.getItem('pomodoro-data');
    if (saved) {
      const data = JSON.parse(saved);
      state.workDuration = data.workDuration || 25;
      state.shortBreakDuration = data.shortBreakDuration || 5;
      state.longBreakDuration = data.longBreakDuration || 15;
      state.longBreakInterval = data.longBreakInterval || 4;
      state.tasks = data.tasks || [];
      state.stats = data.stats || {};
      state.completedPomos = data.completedPomos || 0;
      state.currentTaskId = data.currentTaskId || null;
      state.soundEnabled = data.soundEnabled !== undefined ? data.soundEnabled : true;
    }
  } catch (e) { /* corrupted data */ }
  state.timeLeft = state.workDuration * 60;
  state.totalTime = state.workDuration * 60;
}

function saveData() {
  localStorage.setItem('pomodoro-data', JSON.stringify({
    workDuration: state.workDuration,
    shortBreakDuration: state.shortBreakDuration,
    longBreakDuration: state.longBreakDuration,
    longBreakInterval: state.longBreakInterval,
    tasks: state.tasks,
    stats: state.stats,
    completedPomos: state.completedPomos,
    currentTaskId: state.currentTaskId,
    soundEnabled: state.soundEnabled
  }));
}

// ========== Timer Logic ==========
function startTimer() {
  if (state.isRunning) return;
  state.isRunning = true;
  updateButtons();

  if (state.timerState === STATE_IDLE) {
    setState(STATE_WORK, state.workDuration * 60);
  }

  timerInterval = setInterval(tick, 1000);
  tick();
}

function pauseTimer() {
  state.isRunning = false;
  clearInterval(timerInterval);
  timerInterval = null;
  updateButtons();
}

function resetTimer() {
  pauseTimer();
  setState(STATE_IDLE, state.workDuration * 60);
  updateDisplay();
  updateRing();
}

function skipTimer() {
  pauseTimer();
  if (state.timerState === STATE_WORK) {
    finishPomodoro();
  }
  switchToNextState();
  updateDisplay();
  updateRing();
}

function tick() {
  if (state.timeLeft > 0) {
    state.timeLeft--;
    updateDisplay();
    updateRing();
    updateTrayTitle();
  }

  if (state.timeLeft <= 0) {
    if (state.timerState === STATE_WORK) {
      finishPomodoro();
      playSound('workDone');
      notify('番茄钟完成！', '休息一下吧');
    } else {
      playSound('breakDone');
      notify('休息结束！', '开始新的番茄钟吧');
    }
    switchToNextState();
    updateDisplay();
    updateRing();
    updateTrayTitle();
  }
}

function setState(newState, timeLeft) {
  state.timerState = newState;
  state.timeLeft = timeLeft;
  state.totalTime = timeLeft;
  updateStatusBadge();
  updateTrayIcon();
}

function finishPomodoro() {
  state.completedPomos++;
  const today = getDateString();
  state.stats[today] = (state.stats[today] || 0) + 1;

  if (state.currentTaskId) {
    const task = state.tasks.find(t => t.id === state.currentTaskId);
    if (task) task.pomos = (task.pomos || 0) + 1;
  }

  saveData();
  updateStats();
  renderTasks();
}

function switchToNextState() {
  if (state.timerState === STATE_WORK) {
    if (state.completedPomos > 0 && state.completedPomos % state.longBreakInterval === 0) {
      setState(STATE_LONG_BREAK, state.longBreakDuration * 60);
    } else {
      setState(STATE_SHORT_BREAK, state.shortBreakDuration * 60);
    }
  } else {
    setState(STATE_WORK, state.workDuration * 60);
  }
}

// ========== Display ==========
function updateDisplay() {
  els.timerTime.textContent = formatTime(state.timeLeft);

  if (state.timerState === STATE_WORK || state.timerState === STATE_IDLE) {
    els.sessionLabel.textContent = '第 ' + (state.completedPomos + 1) + ' 个番茄';
  } else if (state.timerState === STATE_SHORT_BREAK) {
    els.sessionLabel.textContent = '短休息';
  } else {
    els.sessionLabel.textContent = '长休息';
  }
}

function updateRing() {
  const progress = state.timeLeft / state.totalTime;
  els.ringProgress.style.strokeDashoffset = CIRCUMFERENCE * (1 - progress);
}

function updateStatusBadge() {
  const badge = els.statusBadge;
  badge.classList.remove('working', 'breaking');

  if (state.timerState === STATE_WORK) {
    badge.textContent = '专注中...';
    badge.classList.add('working');
    els.ringProgress.classList.remove('breaking');
  } else if (state.timerState === STATE_SHORT_BREAK) {
    badge.textContent = '短休息中...';
    badge.classList.add('breaking');
    els.ringProgress.classList.add('breaking');
  } else if (state.timerState === STATE_LONG_BREAK) {
    badge.textContent = '长休息中...';
    badge.classList.add('breaking');
    els.ringProgress.classList.add('breaking');
  } else {
    badge.textContent = '准备开始';
    els.ringProgress.classList.remove('breaking');
  }
}

function updateButtons() {
  if (state.isRunning) {
    els.btnStart.disabled = true;
    els.btnPause.disabled = false;
  } else {
    els.btnStart.disabled = false;
    els.btnPause.disabled = true;
    els.btnStart.textContent = state.timerState === STATE_IDLE ? '▶ 开始' : '▶ 继续';
  }
}

// ========== Tray & Notification ==========
function updateTrayIcon() {
  if (!window.electronAPI) return;
  if (state.timerState === STATE_WORK) {
    window.electronAPI.setTrayIcon('work');
  } else if (state.timerState === STATE_SHORT_BREAK || state.timerState === STATE_LONG_BREAK) {
    window.electronAPI.setTrayIcon('break');
  } else {
    window.electronAPI.setTrayIcon('idle');
  }
}

function updateTrayTitle() {
  if (!window.electronAPI) return;
  const timeStr = formatTime(state.timeLeft);
  window.electronAPI.setTrayTitle(timeStr);
  const label =
    state.timerState === STATE_WORK ? '专注' :
    state.timerState === STATE_SHORT_BREAK ? '短休' :
    state.timerState === STATE_LONG_BREAK ? '长休' : '准备';
  window.electronAPI.setTrayTooltip('番茄钟 - ' + label + ' ' + timeStr);
}

function playSound(type) {
  if (!state.soundEnabled) return;
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const freqs = type === 'workDone'
      ? [523.25, 659.25, 783.99]
      : [523.25, 659.25];
    const spacing = type === 'workDone' ? 0.18 : 0.2;

    freqs.forEach((freq, i) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.3, audioCtx.currentTime + i * spacing);
      gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + i * spacing + 0.4);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(audioCtx.currentTime + i * spacing);
      osc.stop(audioCtx.currentTime + i * spacing + 0.4);
    });
  } catch (e) { /* audio unavailable */ }
}

function notify(title, body) {
  if (window.electronAPI) window.electronAPI.showNotification(title, body);
}

// ========== Tasks ==========
function addTask() {
  const text = els.taskInput.value.trim();
  if (!text) return;

  state.tasks.unshift({
    id: Date.now().toString(),
    text,
    pomos: 0,
    completed: false,
    createdAt: new Date().toISOString()
  });
  els.taskInput.value = '';
  saveData();
  renderTasks();
}

function toggleTask(taskId) {
  const task = state.tasks.find(t => t.id === taskId);
  if (!task) return;
  task.completed = !task.completed;
  if (task.completed && state.currentTaskId === taskId) {
    state.currentTaskId = null;
  }
  saveData();
  renderTasks();
}

function deleteTask(taskId) {
  state.tasks = state.tasks.filter(t => t.id !== taskId);
  if (state.currentTaskId === taskId) state.currentTaskId = null;
  saveData();
  renderTasks();
}

function selectTask(taskId) {
  state.currentTaskId = state.currentTaskId === taskId ? null : taskId;
  saveData();
  renderTasks();
}

function renderTasks() {
  if (state.tasks.length === 0) {
    els.taskList.innerHTML = '';
    els.taskEmpty.style.display = 'block';
    return;
  }

  els.taskEmpty.style.display = 'none';
  els.taskList.innerHTML = state.tasks.map(task => {
    const classes = ['task-item'];
    if (task.completed) classes.push('completed');
    if (task.id === state.currentTaskId) classes.push('active-task');
    return `
      <li class="${classes.join(' ')}" data-id="${task.id}">
        <div class="task-checkbox" data-action="toggle">${task.completed ? '✓' : ''}</div>
        <span class="task-text" data-action="select">${escapeHtml(task.text)}</span>
        <span class="task-pomos">${task.pomos || 0} 🍅</span>
        <button class="task-delete" data-action="delete">✕</button>
      </li>
    `;
  }).join('');
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Task list event delegation
els.taskList.addEventListener('click', (e) => {
  const li = e.target.closest('.task-item');
  if (!li) return;
  const actions = { toggle: toggleTask, select: selectTask, delete: deleteTask };
  const fn = actions[e.target.dataset.action];
  if (fn) fn(li.dataset.id);
});

// ========== Stats ==========
function updateStats() {
  const today = getDateString();
  const monday = getMonday(new Date());

  let todayCount = 0, weekCount = 0, totalCount = 0;
  for (const [date, count] of Object.entries(state.stats)) {
    totalCount += count;
    if (date === today) todayCount = count;
    if (new Date(date) >= monday) weekCount += count;
  }

  els.statToday.textContent = todayCount;
  els.statWeek.textContent = weekCount;
  els.statTotal.textContent = totalCount;

  const totalMinutes = totalCount * state.workDuration;
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  els.statHours.textContent = h > 0 ? h + 'h ' + m + 'm' : m + 'm';

  renderWeeklyChart(monday, today);
}

function renderWeeklyChart(monday, todayStr) {
  const dayNames = ['一', '二', '三', '四', '五', '六', '日'];
  const maxCount = Math.max(1, ...Object.values(state.stats));

  els.chartBars.innerHTML = dayNames.map((name, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    const count = state.stats[getDateString(d)] || 0;
    const height = Math.max(4, (count / maxCount) * 90);
    const isToday = getDateString(d) === todayStr;
    return `
      <div class="chart-bar-wrapper">
        <span class="chart-count">${count}</span>
        <div class="chart-bar${isToday ? ' today' : ''}" style="height: ${height}px"></div>
        <span class="chart-label">${name}</span>
      </div>
    `;
  }).join('');
}

// ========== Settings ==========
function loadSettingsToForm() {
  els.settingWork.value = state.workDuration;
  els.settingShortBreak.value = state.shortBreakDuration;
  els.settingLongBreak.value = state.longBreakDuration;
  els.settingInterval.value = state.longBreakInterval;
  els.settingSound.checked = state.soundEnabled;
}

function saveSettings() {
  if (state.isRunning) pauseTimer();

  state.workDuration = parseInt(els.settingWork.value) || 25;
  state.shortBreakDuration = parseInt(els.settingShortBreak.value) || 5;
  state.longBreakDuration = parseInt(els.settingLongBreak.value) || 15;
  state.longBreakInterval = parseInt(els.settingInterval.value) || 4;
  state.soundEnabled = els.settingSound.checked;

  setState(STATE_IDLE, state.workDuration * 60);
  state.isRunning = false;

  updateDisplay();
  updateRing();
  updateButtons();
  updateStats();
  updateTrayTitle();
  saveData();
}

// ========== Tab Switching ==========
const PANEL_IDS = { tasks: 'panelTasks', stats: 'panelStats', settings: 'panelSettings' };

function switchTab(tabName) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));

  document.querySelector(`[data-tab="${tabName}"]`).classList.add('active');
  $(PANEL_IDS[tabName]).classList.add('active');

  if (tabName === 'stats') updateStats();
  if (tabName === 'settings') loadSettingsToForm();
}

// ========== Event Listeners ==========
els.btnStart.addEventListener('click', startTimer);
els.btnPause.addEventListener('click', pauseTimer);
$('btnReset').addEventListener('click', resetTimer);
$('btnSkip').addEventListener('click', skipTimer);
$('btnAddTask').addEventListener('click', addTask);
$('btnSaveSettings').addEventListener('click', saveSettings);

els.taskInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addTask();
});

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => switchTab(tab.dataset.tab));
});

// ========== Init ==========
function init() {
  loadData();
  updateDisplay();
  updateRing();
  updateStatusBadge();
  updateButtons();
  updateStats();
  renderTasks();
  updateTrayIcon();
  updateTrayTitle();
}

init();
