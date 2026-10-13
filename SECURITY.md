# Security Policy

该插件会启动 Codex CLI、PowerShell 和 Windows Terminal 进程。工作区 `temp/` 保存任务记录与检查点；Codex 的状态目录保存协调租约、启动文件和控制端校验记录。请把进程边界、路径处理、权限参数和状态账本问题视为安全问题处理。完整访问权限下，子任务与控制端同属一个 Windows 用户，状态目录不能提供操作系统级隔离。租约 nonce 只绑定新鲜度和尝试，而非针对同一 Windows 用户 `full-access` 原生进程的认证：该进程可读取 helper 命令行中的 nonce、伪造匹配的 release 标记或影响协调结果；控制端目录对此类进程不是信任边界。

## 隔离验收边界

隔离验收保护的是“工作区任务伪造验收终态”这一较窄的问题，不是恶意本机进程隔离。其认证终态、同一 Windows 用户的 `full-access` 原生进程能力和拒绝服务限制见 [安全边界说明](docs/security-boundaries.md)。

请不要在公开 Issue 中粘贴 API 密钥、账户信息、完整本机路径、运行回执或未修复漏洞的利用细节。首次公开发布前，维护者应在 GitHub 启用并验证 Private Vulnerability Reporting；启用后请使用仓库 Security 页面显示的私密报告入口。在该功能启用前，请通过作者 GitHub 主页中已公开的联系渠道向维护者提供最小复现信息，不要在公开 Issue 中披露利用细节。

报告应包含受影响版本、运行平台、复现步骤和预期/实际行为。维护者会在确认后更新修复状态，并明确哪些验证仍未覆盖。
