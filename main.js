/**
 * 番茄钟 - Electron 主进程
 * ============================
 * 负责：窗口管理、系统托盘、桌面通知、与渲染进程的 IPC 通信
 *
 * 整体架构：
 *   main.js (主进程)  ←→  preload.js (桥接)  ←→  renderer/app.js (界面逻辑)
 *   运行在 Node.js 环境        暴露安全的 API          运行在浏览器环境
 *
 * Electron 的多进程模型：
 *   - 主进程（Main Process）：有完整的 Node.js 能力，管理窗口和系统级功能
 *   - 渲染进程（Renderer Process）：类似浏览器环境，负责 UI，默认不能访问 Node.js API
 *   - contextBridge：在主进程和渲染进程之间安全地传递数据
 */

const { app, BrowserWindow, Tray, Menu, Notification, ipcMain, nativeImage } = require('electron');
const path = require('path');

// ========== 全局状态变量 ==========

// 主窗口实例，null 表示窗口尚未创建或已被销毁
let mainWindow = null;
// 系统托盘实例
let tray = null;
// 标记用户是否正在退出程序。用于区分「关闭窗口」（隐藏到托盘）和「退出程序」（真正退出）
let isQuitting = false;

// ========== 窗口管理 ==========

/**
 * 创建主窗口
 *
 * 窗口配置说明：
 *   - 420×680 固定大小，不允许调整，保证布局稳定
 *   - webPreferences 中关闭 nodeIntegration、开启 contextIsolation，防止渲染进程直接访问 Node.js
 *   - 通过 preload.js 桥接，只暴露必要的 API 给渲染进程
 *   - 关闭按钮行为被拦截：点击 X 不是退出，而是隐藏到托盘
 */
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 420,                    // 窗口宽度（像素）
    height: 680,                   // 窗口高度（像素）
    resizable: false,              // 禁止调整窗口大小，保持界面布局
    frame: true,                   // 显示系统窗口边框（标题栏、关闭按钮等）
    icon: path.join(__dirname, 'assets', 'icon.png'),  // 窗口图标
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),     // 预加载脚本，暴露安全 API
      nodeIntegration: false,      // 关闭 Node.js 集成（安全措施）
      contextIsolation: true       // 开启上下文隔离（安全措施）
    }
  });

  // 加载渲染进程的 HTML 页面
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // 隐藏 Electron 默认菜单栏（文件、编辑、视图等），保持界面简洁
  mainWindow.setMenuBarVisibility(false);

  /**
   * 拦截窗口关闭事件
   *
   * 关键逻辑：
   *   - 如果用户只是点了 X（关闭按钮），isQuitting = false
   *     → 阻止默认关闭行为（event.preventDefault()），改为隐藏窗口到托盘
   *   - 如果用户通过托盘右键菜单选择「退出」，isQuitting = true
   *     → 不阻止，正常退出程序
   *
   * 这样实现了「最小化到托盘」而非「退出程序」的用户体验
   */
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      // 用户只是点了 X → 阻止关闭，隐藏窗口，程序继续在后台运行
      event.preventDefault();
      mainWindow.hide();
    }
    // 如果 isQuitting = true，不阻止，让窗口正常关闭
  });

  // 窗口关闭后的清理：将引用设为 null，方便垃圾回收
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ========== 系统托盘 ==========

/**
 * 创建系统托盘图标
 *
 * 系统托盘（Windows 右下角图标区域）的作用：
 *   - 让程序在后台持续运行，即使用户关闭了主窗口
 *   - 提供快捷菜单（显示窗口 / 退出）
 *   - 双击托盘图标可以显示 / 隐藏窗口
 *   - 托盘上的 tooltip 可以显示当前计时状态
 *
 * 初始图标使用 nativeImage.createEmpty() 创建一个透明占位图标，
 * 之后通过 IPC 由渲染进程通知更新为实际的状态图标（工作中/休息中/空闲）
 */
function createTray() {
  // 用空闲状态的暖灰图标作为初始托盘图标，避免出现短暂空白
  const icon = createTrayIcon('idle');
  tray = new Tray(icon);
  // 设置初始托盘右键菜单
  updateTrayMenu();
  // 设置鼠标悬停在托盘图标上时的提示文字
  tray.setToolTip('番茄钟 - 准备开始');

  /**
   * 双击托盘图标：切换窗口的显示/隐藏
   *
   * 这是一个快捷操作：用户不需要右键打开菜单再点"显示窗口"，
   * 直接双击托盘图标就能恢复窗口
   */
  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
    }
  });
}

/**
 * 更新托盘右键菜单
 *
 * 菜单项：
 *   1. 「显示窗口」— 点击后显示主窗口（窗口可能在托盘隐藏状态）
 *   2. 分隔线
 *   3. 「退出」— 先设置 isQuitting = true，再调用 app.quit()
 *      isQuitting = true 是关键：告诉 close 事件处理器这次是真的要退出，
 *      不要拦截关闭行为
 */
function updateTrayMenu() {
  const contextMenu = Menu.buildFromTemplate([
    {
      label: '显示窗口',
      click: () => {
        // 如果窗口存在就显示它
        if (mainWindow) mainWindow.show();
      }
    },
    { type: 'separator' },  // 菜单分隔线
    {
      label: '退出',
      click: () => {
        // 先标记「正在退出」，这样 close 事件就不会拦截窗口关闭
        isQuitting = true;
        // 通知 Electron 退出应用
        app.quit();
      }
    }
  ]);
  // 将菜单绑定到托盘图标（需要托盘已创建）
  if (tray) {
    tray.setContextMenu(contextMenu);
  }
}

// ========== 桌面通知 ==========

/**
 * 弹出 Windows 系统通知
 *
 * 在 Windows 10/11 上，通知会出现在屏幕右下角的通知中心
 * silent: false 表示通知会伴随系统提示音（如果有的话）
 *
 * 调用时机：
 *   - 番茄钟专注时间完成 → "番茄钟完成！休息一下吧"
 *   - 休息时间结束 → "休息结束！开始新的番茄钟吧"
 */
function showNotification(title, body) {
  // 先检查当前系统是否支持桌面通知（所有现代 Windows 版本都支持）
  if (Notification.isSupported()) {
    new Notification({
      title: title,      // 通知标题
      body: body,        // 通知正文
      silent: false      // 不静音（如果系统通知有关联声音则播放）
    }).show();
  }
}

// ========== IPC 通信（主进程 ↔ 渲染进程） ==========

/**
 * IPC（进程间通信）处理函数
 *
 * 通信流程：
 *   渲染进程 → preload.js（暴露的 API）→ ipcRenderer.invoke() → 主进程 ipcMain.handle()
 *
 * 为什么需要 IPC？
 *   渲染进程出于安全原因不能直接访问 Node.js API 和系统功能（托盘、通知等）。
 *   主进程有这些能力，通过 IPC 暴露给渲染进程使用。
 */

// 显示桌面通知：由渲染进程触发，传递标题和内容
ipcMain.handle('show-notification', (_, title, body) => {
  showNotification(title, body);
});

// 更新托盘 tooltip：显示当前状态和剩余时间
ipcMain.handle('set-tray-tooltip', (_, tooltip) => {
  if (tray) tray.setToolTip(tooltip);
});

// 更新托盘标题（Windows 托盘图标旁边的文字）
ipcMain.handle('set-tray-title', (_, title) => {
  if (tray) tray.setTitle(title);
});

/**
 * 更新托盘图标
 *
 * 根据不同状态显示不同颜色的圆点：
 *   - 'work'：红色圆点，表示正在专注
 *   - 'break'：绿色圆点，表示正在休息
 *   - 其他：灰色圆点，表示空闲状态
 *
 * 图标是程序化生成的（见 createTrayIcon 和 createIconBuffer），
 * 不需要外部图标文件
 */
ipcMain.handle('set-tray-icon', (_, type) => {
  if (!tray) return;
  const icon = createTrayIcon(type);
  tray.setImage(icon);
});

// ========== 托盘图标生成 ==========

/**
 * 根据状态类型生成托盘图标
 *
 * 生成流程：
 *   1. 确定颜色（工作=红、休息=绿、空闲=灰）
 *   2. 在内存中绘制一个 32×32 的带颜色圆点（RGBA 像素缓冲区）
 *   3. 用 nativeImage.createFromBuffer 将像素数据转为 Electron 图像
 *   4. 缩小到 16×16（Windows 托盘标准大小）
 *
 * @param {string} type - 状态类型：'work' | 'break' | 其他
 * @returns {NativeImage} 托盘图标图像
 */
function createTrayIcon(type) {
  const size = 32;  // 原始绘制尺寸（稍大以保证缩小后清晰）

  // 根据状态选择颜色
  let color;
  if (type === 'work')      color = '#C75B49';  // 砖红 - 专注中（与界面主色一致）
  else if (type === 'break') color = '#4A8C7D';  // 青绿 - 休息中（与界面辅色一致）
  else                       color = '#B0A59E';  // 暖灰 - 空闲

  // 将颜色字符串转换为像素缓冲区，再包装为 Electron 原生图像
  const img = nativeImage.createFromBuffer(
    createIconBuffer(size, color),
    { width: size, height: size }
  );
  // 缩小到 Windows 托盘标准尺寸 16×16
  return img.resize({ width: 16, height: 16 });
}

/**
 * 在内存中绘制一个纯色圆形的 RGBA 像素缓冲区
 *
 * 原理：
 *   遍历 32×32 的每个像素，计算该像素到圆心的距离。
 *   距离 ≤ 半径 → 填充目标颜色（完全不透明）
 *   距离 > 半径 → 填充透明（alpha = 0）
 *
 * 像素格式：RGBA（Red, Green, Blue, Alpha），每个通道 1 字节，共 4 字节/像素
 * Buffer 长度 = 32 × 32 × 4 = 4096 字节
 *
 * @param {number} size - 图像尺寸（宽高相同）
 * @param {string} color - 十六进制颜色，如 '#e74c3c'
 * @returns {Buffer} 原始像素数据缓冲区
 */
function createIconBuffer(size, color) {
  // 解析十六进制颜色 → RGB 整数（0-255）
  const r = parseInt(color.slice(1, 3), 16);  // 红色通道
  const g = parseInt(color.slice(3, 5), 16);  // 绿色通道
  const b = parseInt(color.slice(5, 7), 16);  // 蓝色通道

  const bytesPerPixel = 4;  // RGBA = 4 字节/像素
  // 创建指定大小的缓冲区，初始值全部为 0
  const buffer = Buffer.alloc(size * size * bytesPerPixel);

  // 圆心坐标和半径
  const cx = size / 2;
  const cy = size / 2;
  const radius = size / 2 - 1;  // 半径减 1，留一点边距

  // 逐像素绘制圆形
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // 计算当前像素到圆心的距离（勾股定理）
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);

      // 计算当前像素在缓冲区中的起始位置
      const offset = (y * size + x) * bytesPerPixel;

      if (dist <= radius) {
        // 在圆内 → 填充颜色，完全不透明（alpha = 255）
        // 注意：Windows 位图通常使用 BGRA 顺序
        buffer[offset] = b;         // 蓝色
        buffer[offset + 1] = g;     // 绿色
        buffer[offset + 2] = r;     // 红色
        buffer[offset + 3] = 255;   // Alpha（不透明）
      } else {
        // 在圆外 → 完全透明（所有通道都是 0）
        buffer[offset] = 0;
        buffer[offset + 1] = 0;
        buffer[offset + 2] = 0;
        buffer[offset + 3] = 0;
      }
    }
  }
  return buffer;
}

// ========== 应用生命周期 ==========

/**
 * app.whenReady()
 *
 * Electron 应用启动的入口点。
 * 在 Electron 完成初始化（加载模块、准备好 Chromium 引擎）后触发。
 *
 * 启动顺序：
 *   1. 先创建系统托盘（让用户知道程序已启动）
 *   2. 再创建主窗口（显示界面）
 *   3. 更新托盘菜单
 *
 * 为什么先创建托盘？
 *   即使窗口还没显示，托盘图标已经出现，用户可以感知到程序在运行。
 */
app.whenReady().then(() => {
  createTray();
  createWindow();
  updateTrayMenu();
});

/**
 * 所有窗口关闭事件
 *
 * 在 Windows/Linux 上：
 *   不做任何事，不退出程序 → 程序继续在托盘中运行
 *
 * 在 macOS 上：
 *   通常会退出程序（但这里也保持不退出，因为用托盘管理生命周期）
 *
 * 和 close 事件的配合：
 *   用户点 X → close 事件触发 → 拦截并隐藏窗口 → 此时并没有窗口"关闭"，
 *   所以 window-all-closed 不会触发。
 *   只有当 isQuitting = true 时，窗口才真正关闭，触发此事件，
 *   但此时已经标记要退出了，这里不做额外处理。
 */
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    // 在 Windows/Linux 上，不退出程序，保持托盘运行
    // 用户可以随时通过托盘菜单退出
  }
});

/**
 * macOS 特有事件：Dock 图标被点击时重新显示窗口
 * 在 Windows 上通常不会触发，但保留此逻辑以保持跨平台兼容
 */
app.on('activate', () => {
  if (mainWindow) {
    mainWindow.show();
  }
});

/**
 * 应用即将退出前的最后处理
 *
 * 设置 isQuitting = true，确保窗口可以正常关闭而不被拦截。
 * 这个事件的触发时机早于窗口的 close 事件，
 * 所以当 close 事件触发时，isQuitting 已经是 true。
 */
app.on('before-quit', () => {
  isQuitting = true;
});
