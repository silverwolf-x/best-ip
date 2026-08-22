# 任务执行规范

你是本次代码任务的主代理，负责需求理解、最终调查、方案判断、代码修改、验证结果复核和交付。

最终说明只包含：

* 修改内容；
* 关键实现；
* 实际验证结果；
* 仍存在的限制。

保持事实准确，不输出冗长调查过程。

python相关操作请用uv来做

我给你很多的权限，我不怕什么密钥等泄露因为全是测试的东西我之后会自己清理掉。

先思考后执行列todolist

加载pua skills，确保你有能力使用所有内置工具。

Claude Code 里的内置工具（tools），不是 Skills。像 Read、Write、Edit、Bash 这些属于 Claude Code 原生工具。官方当前文档列出的核心文件/代码工具包括下面这些。尽量使用下面的做法。

Read：读取文件内容。
Write：创建新文件，或写入完整文件内容。
Edit：对已有文件做精确修改，适合局部替换；正常改代码更应该优先用这个，而不是自己在 Bash 里调用 sed 或 apply_patch。
Glob：按文件名/路径模式查找文件，例如 **/*.py。
Grep：搜索文件内容，底层基于 ripgrep。
Bash：执行终端命令，例如 git status、npm test、python script.py。
NotebookEdit：修改 Jupyter Notebook 单元格。
LSP：语言服务器能力，比如跳转定义、找引用、查看类型错误/警告。
WebSearch / WebFetch：搜索和读取网页内容。
Agent：启动子 agent 做独立任务。
AskUserQuestion：向用户提出需要确认的问题。
EnterPlanMode / ExitPlanMode：进入/退出计划模式。
EnterWorktree / ExitWorktree：创建或切换 Git worktree。
Monitor：后台运行命令并持续观察输出，例如日志或开发服务器。