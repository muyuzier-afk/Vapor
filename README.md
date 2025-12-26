# Vapor

> 轻量级 LLM API 销售系统，基于 EdgeOne Pages Serverless

## 特性

- **智能路由**：自动识别 OpenAI / Anthropic / Gemini 格式请求
- **流式响应**：完整支持 SSE 流式输出
- **统一计费**：按 Token 独立定价，精确计费
- **LinuxDo 集成**：OAuth 登录 + Credit 积分支付
- **管理后台**：渠道管理、模型配置、用户管理
- **零数据库依赖**：使用 EdgeOne KV 存储

## 快速开始

### 1. 准备工作

- EdgeOne Pages 账号
- LinuxDo OAuth 应用（获取 Client ID/Secret）
- LinuxDo Credit API Key（获取 PID/Key）

### 2. 克隆项目

```bash
git clone <your-repo>
cd vapor
```

### 3. 配置环境变量

在 EdgeOne Pages 控制台配置以下环境变量：

```
# LinuxDo OAuth
OAUTH_CLIENT_ID=your_client_id
OAUTH_CLIENT_SECRET=your_client_secret
OAUTH_REDIRECT_URI=https://your-domain.com/api/auth/callback

# LinuxDo Credit (EPay)
EPAY_PID=your_pid
EPAY_KEY=your_key
EPAY_NOTIFY_URL=https://your-domain.com/api/pay/notify
EPAY_RETURN_URL=https://your-domain.com/api/pay/return

# JWT 密钥（随机生成一个长字符串）
JWT_SECRET=your_random_secret_string

# 管理员 UID（LinuxDo 用户 ID，多个用逗号分隔）
ADMIN_UIDS=12345,67890

# 前端地址（可选）
FRONTEND_URL=https://your-domain.com
```

### 4. 创建 KV 命名空间

在 EdgeOne Pages 控制台创建 KV 命名空间，并绑定到项目。

### 5. 部署

```bash
edgeone pages deploy
```

## API 接口

### LLM API（兼容 OpenAI）

```bash
# Chat Completions
curl https://your-domain.com/v1/chat/completions \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'

# 获取模型列表
curl https://your-domain.com/v1/models
```

### 用户 API

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/auth/login` | GET | OAuth 登录 |
| `/api/auth/callback` | GET | OAuth 回调 |
| `/api/auth/logout` | POST | 退出登录 |
| `/api/auth/me` | GET | 获取当前用户 |
| `/api/user/keys` | GET | 获取 API Keys |
| `/api/user/keys` | POST | 创建 API Key |
| `/api/user/keys/:key` | DELETE | 删除 API Key |
| `/api/user/usage` | GET | 获取用量统计 |
| `/api/user/orders` | GET | 获取订单列表 |

### 支付 API

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/pay/create` | POST | 创建充值订单 |
| `/api/pay/notify` | GET | 支付异步通知 |
| `/api/pay/query/:trade_no` | GET | 查询订单状态 |

### 管理 API

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/admin/channels` | GET/POST | 渠道管理 |
| `/api/admin/channels/:id` | DELETE | 删除渠道 |
| `/api/admin/models` | GET/POST | 模型管理 |
| `/api/admin/models/:id` | DELETE | 删除模型 |
| `/api/admin/users` | GET | 用户列表 |
| `/api/admin/users/:uid` | PUT | 更新用户 |
| `/api/admin/stats` | GET | 统计数据 |

## 项目结构

```
vapor/
├── index.js                 # 主入口
├── package.json
├── wrangler.toml           # EdgeOne 配置
├── functions/
│   ├── api/
│   │   ├── auth/           # OAuth 认证
│   │   ├── user/           # 用户接口
│   │   ├── pay/            # 支付接口
│   │   └── admin/          # 管理接口
│   └── v1/                 # LLM API 代理
├── src/
│   ├── lib/
│   │   ├── kv.js           # KV 存储封装
│   │   ├── oauth.js        # OAuth 工具
│   │   ├── payment.js      # 支付工具
│   │   └── utils.js        # 通用工具
│   └── providers/
│       ├── adapter.js      # 格式转换器
│       ├── openai.js       # OpenAI 提供商
│       ├── anthropic.js    # Anthropic 提供商
│       └── gemini.js       # Gemini 提供商
└── public/
    ├── index.html          # 用户面板
    └── admin.html          # 管理后台
```

## 使用指南

### 添加渠道

1. 登录管理后台
2. 进入「渠道管理」
3. 点击「添加渠道」
4. 填写渠道信息（ID、提供商、API Key 等）
5. 保存

### 添加模型

1. 确保已创建对应渠道
2. 进入「模型管理」
3. 点击「添加模型」
4. 填写模型信息：
   - **模型 ID**：对外展示的模型名（如 `gpt-4o`）
   - **上游模型**：实际调用的模型名（可留空，默认与模型 ID 相同）
   - **关联渠道**：选择该模型使用的渠道
   - **价格**：设置 input/output 每 1K tokens 的价格
5. 保存

### 定价建议

参考上游 API 成本，建议加价 10-30% 作为服务费用：

| 模型 | 官方价格 | 建议售价 |
|------|----------|----------|
| GPT-4o | $5/$15 | $6/$18 |
| Claude 3.5 Sonnet | $3/$15 | $3.5/$18 |
| Gemini 1.5 Pro | $3.5/$10.5 | $4/$12 |

*价格单位：$/1M tokens*

## 注意事项

1. **KV 一致性**：EdgeOne KV 是最终一致性存储，高并发扣费可能存在竞态条件。对于大规模场景，建议接入 Redis 或数据库。

2. **流式响应计费**：流式响应时无法获取准确的 token 数，使用估算值。建议在流结束后异步校准。

3. **安全性**：API Key 和密钥需妥善保管，生产环境务必使用 HTTPS。

4. **请求限制**：EdgeOne Pages 免费套餐 10M 请求/月，注意监控用量。

## License

MIT
