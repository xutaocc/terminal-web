# escli：远程 Windows 文件索引查询

统一名称为 **escli**，默认命令文件为 **`C:\twsshProjecTemp\escli.exe`**。它是 Everything 的 ES 查询客户端，官方包内原名为 `es.exe`。不要求加入 PATH，始终使用绝对路径。

## 首次使用与自动准备

用户要求用 TWSSH 查询远端文件时，默认使用 escli。目标已验证且程序可用时直接查询；首次使用或发现程序缺失时自动运行下面的准备流程，无须再询问是否安装 CLI。不要每次查询都重新下载或预检。

```bash
node "<skill>/scripts/escli.mjs" ensure /absolute/local/escli-task.json
node "<skill>/scripts/twssh.mjs" --project "<project>" --target 8745h task create --spec /absolute/local/escli-task.json --request-id UUID
```

替换实际项目、目标、唯一任务 ID 和尚不存在的本地 spec 路径。按任务 ID 查询 status/wait，完成后读取 logs；不能把创建任务成功当作安装成功。生成器只生成本地 spec；安装和探测由远端任务执行。自定义 Windows 系统目录时调整 spec 的 PowerShell 路径。

`scripts/escli.ps1` 的行为：

- 创建缺失的 `C:\twsshProjecTemp`，拒绝主目录或目标文件为链接。
- 目标已存在则复用，不覆盖、不升级。不存在则从用户指定的固定官方地址 `https://www.voidtools.com/ES-1.1.0.38.x64.zip` 下载 x64 包。
- ZIP 在内存中读取（上限 16 MiB），只提取根条目 `es.exe`（上限 8 MiB）；先写独占新建文件 `C:\twsshProjecTemp\.twssh-escli-install-<UUID>.exe`，再以不覆盖方式发布为 `escli.exe`。不存在磁盘 ZIP 或通用解压目录。
- 成功后临时文件已经移动为最终程序；失败留下临时文件并报告具体路径，不进行递归或前缀清理。默认主目录和旧 `es.exe` 均保留。已有文件损坏时报告，不自动删除重装。
- 通过隐藏窗口、有限超时的 `-get-everything-version` 检查查询实例。结果中 `backendReady` 才表示可查询；`installed` 仅表示本次是否新安装了 CLI。

**Everything 主程序缺失时只提醒用户，不自动下载、安装、启动主程序或修改服务。** IPC 查询失败也可能是未运行、账户/实例不匹配，不能仅凭查询失败断言没有安装。只有 Everything 后台服务运行不一定足够，需要可访问的 Everything 查询实例。用户配置了命名实例时，在查询参数中显式传 `-instance NAME`；默认探测失败不代表该命名实例不可用。

## 查询示例

已确认空闲的 PowerShell 终端可直接执行短查询：

```powershell
& 'C:\twsshProjecTemp\escli.exe' -timeout 5000 -n 20 -json -full-path-and-name 'ext:pdf'
& 'C:\twsshProjecTemp\escli.exe' -timeout 10000 -n 10 -json -full-path-and-name -size -size-format 1 -sort size-descending /a-d 'ext:mp4'
& 'C:\twsshProjecTemp\escli.exe' -timeout 5000 -n 20 -json -path 'C:\workMyHome' /ad 'a260917'
```

第二条按文件大小降序返回最大的 10 个 MP4，大小单位为字节；第三条仅查目录。独立任务使用以下 spec，避免多层 Shell 转义：

```json
{
  "executable": "C:/twsshProjecTemp/escli.exe",
  "args": ["-timeout", "10000", "-n", "10", "-json", "-full-path-and-name", "-size", "-size-format", "1", "-sort", "size-descending", "/a-d", "ext:mp4"],
  "cwd": "C:/twsshProjecTemp",
  "timeoutMs": 20000
}
```

优先限制返回条数和搜索目录，避免全量输出占用上下文。查询结果来自索引，零结果不是执行失败，也不证明磁盘上绝不存在；传输或删除前再核对实际路径。不要把查询变成重建索引、修改 Everything 配置或自动删除文件。

参数参考：[Everything 官方 ES 文档](https://www.voidtools.com/support/everything/command_line_interface/)。
