# EVmessages - Business Chat System

A controlled business-to-customer chat platform where access is gated by admin approval. All conversations are one-to-one between customers and the business.

## Features

- **User Registration & Access Control** - Admin approval workflow with user statuses (Pending, Approved, Rejected, Suspended)
- **Real-time Messaging** - Socket.io powered 1:1 chats with typing indicators
- **Media Permission System** - Admin-controlled per-user media sharing
- **Announcements/Broadcasts** - Send updates to all or selected users
- **Business Reports** - Transaction issue reporting system
- **Admin Dashboard** - User management, message monitoring, report handling

## Tech Stack

- **Runtime:** Node.js v18+
- **Framework:** Express.js v5
- **Real-time:** Socket.io v4
- **Database:** PostgreSQL (via Xata or local)
- **ORM:** Prisma v7 (with driver adapters)
- **Authentication:** JWT (jose) + Argon2
- **Validation:** Zod
- **Logging:** Pino

## Prerequisites

- Node.js v18 or higher
- PostgreSQL database (local or cloud like Xata)
- Redis (optional, for Socket.io scaling)

## Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/benkaesy820/doedev360.git
   cd doedev360
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Set up environment variables**
   ```bash
   cp .env.example .env
   ```
   
   Edit `.env` and update:
   ```
   DATABASE_URL="postgresql://user:password@host:port/database?sslmode=require"
   JWT_SECRET="your-secure-jwt-secret"
   REFRESH_TOKEN_SECRET="your-secure-refresh-secret"
   ```

4. **Generate Prisma client**
   ```bash
   npx prisma generate
   ```

5. **Push database schema**
   ```bash
   npx prisma db push
   ```

6. **Seed test users (optional)**
   ```bash
   npm run db:seed
   ```

## Running the Application

### Development
```bash
npm run dev
```

### Production
```bash
npm start
```

The server will start on `http://localhost:5000`

## API Endpoints

### Authentication
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/register` | Register new user |
| POST | `/api/auth/login` | Login |
| POST | `/api/auth/refresh-token` | Refresh access token |
| POST | `/api/auth/logout` | Logout |
| GET | `/api/auth/me` | Get current user |

### User Management (Admin)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/users` | List all users |
| GET | `/api/users/:id` | Get user details |
| PATCH | `/api/users/:id/status` | Approve/reject/suspend user |
| PATCH | `/api/users/:id/media-permission` | Grant/revoke media permission |

### Messaging
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/conversations/my-conversation` | Get user's conversation |
| GET | `/api/conversations` | List all conversations (Admin) |
| GET | `/api/conversations/:id/messages` | Get messages |
| POST | `/api/conversations/:id/messages` | Send message |
| PATCH | `/api/conversations/:id/read` | Mark as read |

### Announcements
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/announcements` | List announcements |
| GET | `/api/announcements/unread-count` | Get unread count |
| POST | `/api/announcements` | Create announcement (Admin) |
| POST | `/api/announcements/:id/read` | Mark as read |

### Business Reports
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/reports/my-reports` | Get user's reports |
| GET | `/api/reports` | List all reports (Admin) |
| POST | `/api/reports` | Submit report |
| PATCH | `/api/reports/:id/status` | Update status (Admin) |

## Socket.io Events

### Client → Server
- `authenticate` - Send JWT token
- `typing_start` - User started typing
- `typing_stop` - User stopped typing
- `join_conversation` - Join conversation room
- `leave_conversation` - Leave conversation room

### Server → Client
- `authenticated` - Authentication successful
- `auth_error` - Authentication failed
- `receive_message` - New message
- `typing_start` / `typing_stop` - Typing indicators

## Test Credentials

After running `npm run db:seed`:

| Role | Email | Password |
|------|-------|----------|
| Admin | admin@evmessages.com | admin123 |
| User | user@example.com | user123 |

## Project Structure

```
├── prisma/
│   ├── schema.prisma    # Database models
│   └── seed.js          # Seed script
├── src/
│   ├── config/          # App & database config
│   ├── middleware/      # Auth & error handling
│   ├── routes/          # API endpoints
│   ├── sockets/         # Socket.io handlers
│   ├── utils/           # JWT, validators, logger
│   ├── app.js           # Express app
│   └── server.js        # Entry point
├── .env.example         # Environment template
└── package.json
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start development server with hot reload |
| `npm start` | Start production server |
| `npm run db:migrate` | Run database migrations |
| `npm run db:push` | Push schema to database |
| `npm run db:seed` | Seed test data |
| `npm run db:studio` | Open Prisma Studio |

## License

Private - All rights reserved
