# 安全说明

## 本仓库不含凭证

仓库中**没有任何账号、token、cookie、邮箱或个人信息**。所有凭证类文件均被 `.gitignore` 排除：

- `accounts.json`：账号池（含 token）
- `jwt.txt`：当前账号 token
- `usage.jsonl`：用量台账
- `cookie*.txt` / `cf_clearance.txt`：浏览器会话
- `ck_*.json`：cookie 导出文件

## 运行时数据

首次运行会在当前目录生成上述文件，仅存在于本机。**不要提交、不要外发、不要截图带出。**

## 报告问题

发现安全问题请开 issue，或在交流群 **1130166963** 反馈：<https://qm.qq.com/q/NBX5cnLfIC>
