using System.Net.Http;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Windows;
using System.Windows.Media;
using Hardcodet.Wpf.TaskbarNotification;
using Microsoft.Web.WebView2.Core;

namespace MoYuCode.Win;

public partial class MainWindow : Window
{
    // Debug 模式使用 Vite 开发服务器（需要运行 npm run dev）
    // 如果不想运行 Vite，可以将下面的 5173 改为 9110
#if DEBUG
    private const string LocalUrl = "http://localhost:5173";
#else

    private const string LocalUrl = "http://localhost:9110";
#endif

    private TaskbarIcon? _notifyIcon;
    private bool _isExiting;

    public MainWindow()
    {
        InitializeComponent();
        InitializeNotifyIcon();
        Loaded += MainWindow_Loaded;
        StateChanged += MainWindow_StateChanged;
    }

    private void InitializeNotifyIcon()
    {
        _notifyIcon = new TaskbarIcon
        {
            Icon = new System.Drawing.Icon(Application.GetResourceStream(new Uri("pack://application:,,,/favicon.ico")).Stream),
            ToolTipText = "MoYuCode（摸鱼Coding）",
            Visibility = Visibility.Visible
        };

        _notifyIcon.TrayMouseDoubleClick += (s, e) => ShowWindow();

        var contextMenu = new System.Windows.Controls.ContextMenu();

        var showItem = new System.Windows.Controls.MenuItem { Header = "显示窗口" };
        showItem.Click += (s, e) => ShowWindow();
        contextMenu.Items.Add(showItem);

        contextMenu.Items.Add(new System.Windows.Controls.Separator());

        var exitItem = new System.Windows.Controls.MenuItem { Header = "退出" };
        exitItem.Click += (s, e) => ExitApplication();
        contextMenu.Items.Add(exitItem);

        _notifyIcon.ContextMenu = contextMenu;
    }

    private void ShowWindow()
    {
        Show();
        WindowState = WindowState.Normal;
        Activate();
    }

    private void ExitApplication()
    {
        _isExiting = true;

        // 延迟执行以避免在菜单事件中直接关闭导致死锁
        Dispatcher.BeginInvoke(new Action(() =>
        {
            // 先清理 WebView2
            WebView.Dispose();

            // 清理托盘图标
            _notifyIcon?.Dispose();
            _notifyIcon = null;

            // 关闭应用
            Application.Current.Shutdown();
        }), System.Windows.Threading.DispatcherPriority.Background);
    }

    private async void MainWindow_Loaded(object sender, RoutedEventArgs e)
    {
        try
        {
            LoadingText.Text = "正在初始化 WebView2...";
            await WebView.EnsureCoreWebView2Async();

            WebView.CoreWebView2.Settings.IsStatusBarEnabled = false;
            WebView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = true;
            WebView.CoreWebView2.Settings.IsZoomControlEnabled = true;

            // 监听前端主题变化
            WebView.CoreWebView2.WebMessageReceived += OnWebMessageReceived;

            WebView.NavigationCompleted += (s, args) =>
            {
                if (args.IsSuccess)
                {
                    LoadingText.Visibility = Visibility.Collapsed;
                    WebView.Visibility = Visibility.Visible;
                    // 注入主题监听脚本
                    InjectThemeListener();
                }
                else
                {
                    LoadingText.Text = $"页面加载失败: {args.WebErrorStatus}";
                }
            };

            LoadingText.Text = "正在等待后端服务启动...";
            await WaitForBackendAsync();

            LoadingText.Text = "正在加载页面...";
            WebView.Source = new Uri(LocalUrl);
        }
        catch (Exception ex)
        {
            LoadingText.Text = $"加载失败: {ex.Message}";
        }
    }

    private async void InjectThemeListener()
    {
        var script = """
            (function() {
                function sendTheme() {
                    const isDark = document.documentElement.classList.contains('dark');
                    window.chrome.webview.postMessage(JSON.stringify({ type: 'theme', isDark: isDark }));
                }

                // 延迟发送初始主题，确保 next-themes 已初始化
                setTimeout(sendTheme, 100);

                // 监听 class 属性变化（next-themes 使用 class 切换主题）
                const observer = new MutationObserver(function(mutations) {
                    for (const mutation of mutations) {
                        if (mutation.attributeName === 'class') {
                            sendTheme();
                            break;
                        }
                    }
                });
                observer.observe(document.documentElement, {
                    attributes: true,
                    attributeFilter: ['class']
                });

                // 监听 localStorage 变化（跨标签页同步）
                window.addEventListener('storage', function(e) {
                    if (e.key === 'theme') {
                        setTimeout(sendTheme, 50);
                    }
                });
            })();
            """;
        await WebView.CoreWebView2.ExecuteScriptAsync(script);
    }

    private void OnWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        try
        {
            // WebMessageAsJson 返回的是 JSON 字符串的 JSON 表示，需要先解析出字符串
            var jsonString = JsonSerializer.Deserialize<string>(e.WebMessageAsJson);
            if (string.IsNullOrEmpty(jsonString)) return;

            var message = JsonSerializer.Deserialize<ThemeMessage>(jsonString);
            if (message?.Type == "theme")
            {
                Dispatcher.Invoke(() => ApplyTheme(message.IsDark));
            }
        }
        catch
        {
            // 忽略解析错误
        }
    }

    private void ApplyTheme(bool isDark)
    {
        if (isDark)
        {
            MainBorder.Background = new SolidColorBrush((Color)ColorConverter.ConvertFromString("#1e1e1e"));
            TitleBarBorder.Background = new SolidColorBrush((Color)ColorConverter.ConvertFromString("#323233"));
            TitleText.Foreground = new SolidColorBrush((Color)ColorConverter.ConvertFromString("#cccccc"));
        }
        else
        {
            MainBorder.Background = new SolidColorBrush((Color)ColorConverter.ConvertFromString("#ffffff"));
            TitleBarBorder.Background = new SolidColorBrush((Color)ColorConverter.ConvertFromString("#f3f3f3"));
            TitleText.Foreground = new SolidColorBrush((Color)ColorConverter.ConvertFromString("#333333"));
        }
    }

    private void MainWindow_StateChanged(object? sender, EventArgs e)
    {
        // 更新最大化按钮图标
        MaximizeButton.Content = WindowState == WindowState.Maximized ? "\uE923" : "\uE922";
        MaximizeButton.ToolTip = WindowState == WindowState.Maximized ? "还原" : "最大化";
    }

    private void MinimizeButton_Click(object sender, RoutedEventArgs e)
    {
        WindowState = WindowState.Minimized;
    }

    private void MaximizeButton_Click(object sender, RoutedEventArgs e)
    {
        WindowState = WindowState == WindowState.Maximized
            ? WindowState.Normal
            : WindowState.Maximized;
    }

    private void CloseButton_Click(object sender, RoutedEventArgs e)
    {
        Hide();
    }

    protected override void OnClosing(System.ComponentModel.CancelEventArgs e)
    {
        if (!_isExiting)
        {
            e.Cancel = true;
            Hide();
        }
        base.OnClosing(e);
    }

    private static async Task WaitForBackendAsync()
    {
        using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };
        var maxRetries = 30;

        for (var i = 0; i < maxRetries; i++)
        {
            try
            {
                var response = await client.GetAsync(LocalUrl);
                if (response.IsSuccessStatusCode)
                {
                    return;
                }
            }
            catch
            {
                // 服务还没启动，继续等待
            }

            await Task.Delay(200);
        }
    }

    private record ThemeMessage(
        [property: JsonPropertyName("type")] string Type,
        [property: JsonPropertyName("isDark")] bool IsDark);
}
