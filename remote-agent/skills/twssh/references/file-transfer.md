# 文件推送与拉取

使用已有目标配置和 HTTP 连接。服务端需要 `transfers-v1`；旧端拒绝请求时报告需升级，不改用终端 Base64 搬运文件。此功能不创建远程终端，也不占用正在运行的终端。

```bash
node "<skill>/scripts/twssh.mjs" --project "<project>" --target 8745h file push --spec /local/push.json
node "<skill>/scripts/twssh.mjs" --project "<project>" --target 8745h file pull --spec /local/pull.json
node "<skill>/scripts/twssh.mjs" --project "<project>" --target 8745h file transfer-status --transfer UUID
node "<skill>/scripts/twssh.mjs" --project "<project>" --target 8745h file transfer-cleanup --transfer UUID
```

push.json 示例（root 在本地；destination 是远端完整文件名）：

```json
{
  "root": "/absolute/local/project",
  "paths": ["src", "package.json"],
  "exclude": ["src/cache"],
  "destination": "C:/twsshProjecTemp/project.zip",
  "compression": "store"
}
```

pull.json 示例（root 在远端；destination 是本地完整文件名）：

```json
{
  "root": "C:/twsshProjecTemp",
  "paths": ["hello-python"],
  "exclude": ["hello-python/__pycache__"],
  "destination": "/absolute/local/hello-python.zip",
  "compression": "store"
}
```

- paths 为 root 下的相对路径数组，使用 `/`。`["."]` 表示整个目录。exclude 为明确的相对路径及其子树，不是 glob；没有隐式排除项。不要把 Token、连接状态等秘密文件打包给未授权目的地。
- 单文件直接传输；多文件/目录自动 ZIP，目标名须以 `.zip` 结尾。单文件可用 `pack:true` 强制 ZIP。默认 `compression:"store"`，只打包、不压缩；仅显式指定 `compression:"fast"` 时使用 Deflate level 1 轻度压缩。客户端拉取时会显式发送默认 store，因此已支持传输接口的旧服务无需重启即可按此方式打包。不会自动解压或执行内容。
- 使用二进制 HTTP 流，SHA-256 与字节数验证成功后才发布目标。默认 Windows 主目录不存在时创建；其他目标父目录须存在，始终不覆盖。发布依赖同卷硬链接（如 APFS/NTFS）；不支持时保留临时文件并报错，不降级为覆盖复制。
- 当前每次最多 1 GiB（选中文件总量和归档/传输体积均有限制）、60,000 个 ZIP 条目。不支持断点续传、增量同步、符号链接、特殊文件或完整权限还原。不要承诺大型备份能力。
- 输出仅回执、路径、大小、哈希和清理结果，不把文件内容送入模型上下文。

## 默认主目录（重要约定）

Windows 上无论作为控制端还是被控端，TWSSH 默认工作与传输临时主目录统一为 **`C:\twsshProjecTemp\`**。不存在时创建；若权限不足、路径不是目录或是链接，则停止并报告，不默默切换系统 TEMP。用户明确指定的项目工作目录仍可使用，不强行迁移已有项目。

- Windows 打包与接收临时目录：`C:\twsshProjecTemp\.twssh-transfer-<UUID>-<随机后缀>\`。
- Windows 最终 ZIP 默认建议：`C:\twsshProjecTemp\<项目名>.zip`。spec.destination 仍需显式填写，不能把临时文件名当作最终路径。
- Windows 最终项目目录默认建议：`C:\twsshProjecTemp\<项目名>\`。这只是需要解压时应向用户说明的目标，当前命令不会自动解压。
- macOS/Linux 不创建字面量 Windows 路径：打包仍使用各自系统临时目录，接收仍在目标父目录暂存；对用户须列出所在主机及其实际绝对路径。
- 固定 Windows 暂存主目录后，当前接收目标必须与它同卷（当前实现还要求相同盘符）。跨卷在传输前拒绝，不回退到其他暂存位置，也不改用覆盖复制。其他目标父目录须已存在，仅默认主目录自动创建。
- **主目录不是可整体删除的缓存目录。** 不删除整个 `C:\twsshProjecTemp`，不清理其中其他项目、历史 ZIP、其他会话目录或用户文件。

## 传输与自动解压的事前路径确认

所有传输先说明路径和清理范围；如果需求包含“压缩包传输并自动解压”，必须在传输开始前一次性列清以下计划，获得用户对该计划的明确确认，再执行传输和解压。不能先传完再确认解压，也不能把一般的开发授权当作具体路径确认。

| 必须说明的内容 | 要求 |
|---|---|
| 控制端与被控端身份 | 主机名称、方向，不能只写“本地/远程”而不指明是哪台 |
| 源目录与文件选择 | 双端相关源路径、包含哪些文件、排除哪些目录 |
| 打包临时目录与临时 ZIP | 所在主机和完整绝对路径 |
| 接收临时目录与 payload.part | 所在主机和完整绝对路径 |
| 最终保存的 ZIP／文件 | 双端实际会保留的文件及目录；未生成的项明确写“不适用” |
| 解压暂存与最终项目目录 | 所在主机、准确路径、是否新建、同名目标如何处理 |
| 清理与保留 | 逐项列出哪些临时文件会在什么成功条件下清理；哪些 ZIP、源文件、项目目录保留；失败时哪些可能残留 |

确认计划应使用本次具体路径；UUID/随机后缀尚未确定时只能称为模板，不能当成已确认的准确路径。若现有工具不能提前给出所需准确路径，先补齐规划或说明当前无法执行该自动解压流程，不能先开始传输来探路。确认后的路径、目标或删除范围变化，需要重新确认变化后的计划。

当前 `file push/pull` **不支持自动解压或解压路径规划**；传入 extract/extractTo 会明确拒绝。不能把“已传输”说成“已解压”，也不能绕过此规则擅自通过终端解压。将来执行独立解压流程也遵循上述确认约束；解压应使用本次专属暂存目录，拒绝越界条目和链接，不覆盖已有项目。最终 ZIP 默认保留，只有确认计划明确列入删除范围时才可另行处理。

## 临时文件与删除规则

临时目录格式 `.twssh-transfer-<UUID>-<随机后缀>`，含 `owner.json`、`archive.zip` 或 `payload.part`。Windows 两类临时目录均位于上述 `C:\twsshProjecTemp\` 主目录下；macOS/Linux 打包在系统临时目录、接收在目标父目录。前缀只用于识别，不是删除授权。

脚本仅清理当前进程创建并记录的精确目录和精确文件，校验目录身份、真实路径、文件身份及大小/修改元数据。所有文件预检通过后，逐个再校验、unlink，最后空目录 rmdir；不使用递归删除、前缀搜索或按年龄批量清理。

发现未知文件、链接、替换、修改或未完成写入时，宁可保留目录，返回 retainedPath/reason。传输成功与清理成功分别报告；不能因为清理失败重复传输。传输失败时保留未完成文件属于预期保守行为。

transfer-cleanup 只对远端内存中仍持有归属记录的指定 UUID 执行上述校验，不删除发布的目标文件或源文件。拒绝清理正在准备/传输的任务。不接受任意路径，不提供 --force。

拉取的远端状态 `sent` 仅表示发送流结束，不能证明本地保存成功；以本地返回的 `verified:true` 为准。

状态记录只在服务进程生命周期内有效，最多保留 200 条，达到上限时可淘汰已清理记录；服务重启后不会扫描并认领旧临时目录。旧目录需要人工核实，AI 不可仅凭前缀或 owner.json 用 rm -rf / Remove-Item -Recurse 清理。此策略优先避免误删，允许残留。

每次调用先保存 transferId；超时/响应丢失先查 transfer-status。unknown/not found 或重启不意味着未写入，先核对目标和哈希，不换 UUID 自动重传。失败回执和 stderr 会保留 ID 与已知临时路径。
