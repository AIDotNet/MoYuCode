using System.Windows;
using Microsoft.AspNetCore.Builder;
using MoYuCode;

namespace MoYuCode.Win;

public partial class App : Application
{
    private WebApplication? _webApp;
    private Task? _webAppTask;

    public WebApplication? WebApp => _webApp;

    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);

        try
        {
            _webApp = MoYuCodeApp.Create([], out _);
            // 使用 RunAsync 在后台运行，不阻塞 UI 线程
            _webAppTask = _webApp.RunAsync();
        }
        catch (Exception ex)
        {
            MessageBox.Show($"启动后端服务失败: {ex.Message}", "错误", MessageBoxButton.OK, MessageBoxImage.Error);
            Shutdown(1);
        }
    }

    protected override void OnExit(ExitEventArgs e)
    {
        if (_webApp != null)
        {
            try
            {
                // 停止 Web 应用
                using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(3));
                _webApp.StopAsync(cts.Token).GetAwaiter().GetResult();
            }
            catch
            {
                // 忽略关闭时的错误
            }
        }

        base.OnExit(e);
    }
}
