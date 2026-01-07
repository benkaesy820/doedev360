# Business Chat System - Technical Specification
## Tech Stack: Node.js + PostgreSQL + Socket.io

## Core Concept
A controlled business-to-customer chat platform where access is gated by admin approval. All conversations are one-to-one between customers and the business.

---

## Technology Stack

### Backend
- **Runtime:** Node.js (v18+ LTS)
- **Framework:** Express.js
- **Real-time:** Socket.io
- **Database:** PostgreSQL (v14+)
- **ORM:** Sequelize or Prisma
- **Authentication:** JWT + bcrypt
- **Session Management:** Redis (for Socket.io sessions)

### Storage & Services
- **File Storage:** AWS S3 or Cloudinary
- **CDN:** CloudFront or Cloudinary CDN
- **Email:** SendGrid or AWS SES
- **SMS:** Twilio
- **Push Notifications:** Firebase Cloud Messaging (FCM)

### Hosting & Infrastructure
- **Application Server:** Railway, Render, or DigitalOcean App Platform
- **Database Hosting:** Supabase, Railway, or managed PostgreSQL
- **Redis:** Redis Cloud or Railway Redis
- **Environment:** Docker containers (optional but recommended)

### Development Tools
- **API Testing:** Postman or Thunder Client
- **Version Control:** Git + GitHub/GitLab
- **Process Manager:** PM2
- **Logging:** Winston or Pino
- **Monitoring:** Sentry (error tracking)

---

## User Registration & Access

**Registration Fields:**
- Name
- Email address
- Phone number

**Access Control:**
- New signups → Pending status (no chat access)
- Admin reviews and approves/rejects
- Rejected users can reapply
- Reapplication shows rejection history marker
- No notification sent for rejections

**User Status Flow:**
1. **Pending** → Awaiting admin approval, cannot chat
2. **Approved** → Full chat access
3. **Rejected** → Cannot access, can reapply
4. **Suspended** → Cannot login, sees "Account Suspended" message

---

## Messaging System

**Direct Messaging:**
- One-to-one only (User ↔ Admin)
- Users cannot see or contact other users
- Full conversation history visible on login
- Typing indicators ("Admin is typing...") via Socket.io events
- Message timestamps (format: 2:59:43 PM)
- Auto-close message after 1 hour of inactivity: "Chat session closed"

**Media Sharing:**
- Controlled by admin per user
- Admin grants/revokes media permission individually
- User receives notification when granted permission
- Without permission: shows "Permission not granted" message

---

## Broadcast & Announcements

**Admin Broadcast Options:**
- Send to all approved users, OR
- Send to selected users (checkboxes + search)

**Announcement/Community Room:**
- Separate section for broadcasts
- Users view all past announcements
- Recent announcements displayed by default
- Notification badge shows unread count

**Business Report (Incident Reporting):**
- Users can report transaction issues
- Required fields: Order ID, Paystack Receipt Reference, or MoMo Transaction ID
- Users submit report with transaction details
- Reports appear on admin dashboard with "Pending Review" status
- Admin can update status to: "Working on it", "Completed", or "Rejected"
- Users can view their submitted reports and status updates

---

## Admin Dashboard

**Dashboard Priority View:**
- **Unread messages** (primary focus)
- Pending approval requests
- User management panel

**User Management:**
- View all users by status (Pending, Approved, Rejected, Suspended)
- Approve/reject pending users
- Suspend/unsuspend approved users
- Individual media permission controls
- View rejection history on reapplications

**Broadcast Tools:**
- Compose broadcast message
- Select recipients (all or specific users via checkboxes/search)
- Send to announcement room

**Settings:**
- Configurable admin preferences
- Approval mode toggle (future: auto-approve option)

---

## Notifications

**Admin receives notifications for:**
- New user registrations
- New messages from users

**Users receive notifications for:**
- Account approval
- Media permission granted
- New announcements (badge indicator)
- New admin messages

---

## Database Schema (PostgreSQL)

### Users Table
- id, name, email (unique), phone (unique), password_hash
- status: pending, approved, rejected, suspended
- media_permission (boolean), rejection_count
- created_at, updated_at, last_login timestamps

### Messages Table
- id, conversation_id (FK), sender_id (FK)
- sender_type: 'user' or 'admin'
- message_text, media_url, media_type
- is_read (boolean), created_at timestamp

### Conversations Table
- id, user_id (FK), admin_id (FK)
- last_message_at timestamp
- status: active, closed
- created_at timestamp

### Announcements Table
- id, title, content
- created_by (FK to users)
- created_at timestamp

### Announcement Reads Table
- id, announcement_id (FK), user_id (FK)
- read_at timestamp
- Unique constraint on (announcement_id, user_id)

### Business Reports Table
- id, user_id (FK)
- order_id, paystack_reference, momo_transaction_id
- description, admin_notes
- status: pending, working, completed, rejected
- created_at, updated_at timestamps

### User Status History Table
- id, user_id (FK), changed_by (FK)
- old_status, new_status
- reason text
- created_at timestamp

---

## API Architecture

### RESTful Endpoints

**Authentication:**
- `POST /api/auth/register` - User registration
- `POST /api/auth/login` - User/Admin login
- `POST /api/auth/logout` - Logout
- `POST /api/auth/refresh-token` - Refresh JWT
- `POST /api/auth/forgot-password` - Password reset request
- `POST /api/auth/reset-password` - Password reset confirmation

**User Management (Admin):**
- `GET /api/admin/users` - List all users (with filters)
- `GET /api/admin/users/:id` - Get user details
- `PATCH /api/admin/users/:id/approve` - Approve user
- `PATCH /api/admin/users/:id/reject` - Reject user
- `PATCH /api/admin/users/:id/suspend` - Suspend user
- `PATCH /api/admin/users/:id/media-permission` - Grant/revoke media permission

**Messaging:**
- `GET /api/conversations` - Get user's conversations
- `GET /api/conversations/:id/messages` - Get conversation messages
- `POST /api/conversations/:id/messages` - Send message (REST fallback)
- `PATCH /api/messages/:id/read` - Mark message as read

**Announcements:**
- `POST /api/announcements` - Create announcement (Admin)
- `GET /api/announcements` - Get all announcements
- `POST /api/announcements/:id/read` - Mark announcement as read

**Business Reports:**
- `POST /api/reports` - Submit business report
- `GET /api/reports` - Get user's reports
- `GET /api/admin/reports` - Get all reports (Admin)
- `PATCH /api/admin/reports/:id/status` - Update report status (Admin)

### Socket.io Events

**Connection:**
- `connection` - Client connects
- `authenticate` - Send JWT for Socket authentication
- `disconnect` - Client disconnects

**Messaging:**
- `send_message` - Send real-time message
- `receive_message` - Receive real-time message
- `typing_start` - User starts typing
- `typing_stop` - User stops typing
- `message_delivered` - Message delivery confirmation
- `message_read` - Message read receipt

**Notifications:**
- `new_user_registration` - Admin notification
- `user_approved` - User notification
- `media_permission_granted` - User notification
- `new_announcement` - Broadcast to users
- `report_status_updated` - User notification

**Session Management:**
- `session_timeout` - 1-hour inactivity warning
- `session_closed` - Auto-close chat session

---

## Real-Time Architecture (Socket.io)

### Connection Flow
1. Client connects to Socket.io server
2. Client emits `authenticate` event with JWT token
3. Server validates JWT and stores socket.id → user.id mapping in Redis
4. Server joins user to their personal room: `user:${userId}`
5. Admin joins `admin` room for broadcast capabilities

### Room Structure
- User-specific rooms: `user:${userId}` for direct messages
- Admin room: `admin` for admin notifications
- Conversation rooms: `conversation:${conversationId}` for typing indicators
- Approved users room: `approved_users` for announcement broadcasts

### Redis Session Store
- Store socket.id → user mapping
- Track userId, role, conversationId, connectedAt
- Key format: `socket:{socketId}`

---

## Security Implementation

### Authentication (JWT)
**JWT Payload contains:**
- userId, email, role (user/admin)
- Issued at (iat) and expiration (exp) - 1 hour

**Refresh Token (stored in database):**
- userId, hashed token, expiration date (7 days)

### Password Hashing
- Use `bcrypt` with salt rounds = 10
- Store hashed passwords only

### Rate Limiting
- Login attempts: 5 per 15 minutes
- Message sending: 30 per minute

### File Upload Security
- Validate file types (whitelist: jpg, png, pdf, etc.)
- Limit file size: 10MB per file
- Scan files with ClamAV or VirusTotal API
- Generate unique filenames (UUID)
- Store in S3 with private access, generate signed URLs

---

## Development Phasing Strategy

### Phase 1: Core Foundation (MVP) - 3-4 weeks
**Priority: Critical for Launch**

**Week 1-2: Backend Setup**
- Initialize Node.js + Express project
- Setup PostgreSQL database + Sequelize/Prisma
- Create database schema and migrations
- Implement JWT authentication
- User registration and login endpoints
- Admin approval API endpoints

**Week 2-3: Real-Time Messaging**
- Setup Socket.io server
- Implement one-to-one messaging
- Store messages in PostgreSQL
- Typing indicators
- Message timestamps
- Conversation history retrieval

**Week 3-4: Basic Admin Dashboard**
- Admin login
- User management APIs (approve/reject/suspend)
- View pending users
- Unread message tracking
- Basic notifications (Socket.io events)

**Deliverable:** Functional chat system with admin approval

---

### Phase 2: Enhanced Security & Control - 2-3 weeks

**Security Features:**
- Email verification (SendGrid integration)
- SMS OTP verification (Twilio integration)
- Password recovery system
- Duplicate registration prevention (check email/phone)
- Rate limiting implementation
- Message delivery status tracking

**Admin Tools:**
- User search functionality
- Internal notes on users (new table)
- View user status history
- Admin activity logging

**Deliverable:** Production-ready security features

---

### Phase 3: Advanced Features - 3-4 weeks

**Media & Broadcasting:**
- Media permission controls
- File upload to S3/Cloudinary
- Virus scanning integration
- Broadcast system (all users + targeted)
- Announcement/Community room
- Unread announcement badges

**Business Reports:**
- Report submission form
- Admin dashboard for reports
- Report status updates
- User report viewing

**Chat Enhancements:**
- Message editing/deletion
- Conversation archiving
- Auto-close inactive sessions (1 hour)
- Quick reply templates

**Deliverable:** Full-featured platform

---

### Phase 4: Analytics & Optimization - 2-3 weeks

**Analytics:**
- Messages per day tracking
- Average response time
- User growth metrics
- Active conversations tracking

**Performance:**
- Database indexing optimization
- Query performance monitoring
- Socket.io scaling (Redis adapter)
- Connection status indicators
- Offline mode support (queue messages)

**Deliverable:** Scalable, monitored system

---

### Phase 5: Compliance & Scale - As Needed

**Compliance:**
- GDPR data export tools
- User data deletion API
- Data retention policies
- Admin audit trails

**Advanced Admin:**
- Multi-admin support with roles
- Admin succession planning
- Bulk actions
- Advanced user tagging

**Deliverable:** Enterprise-ready platform

---

## Technical Infrastructure Requirements

### Development Environment
**Required installations:**
- Node.js v18+ LTS
- PostgreSQL v14+
- Redis v6+
- Docker (optional but recommended)
- Git

### Environment Variables (.env)
**Server:** NODE_ENV, PORT

**Database:** DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD

**Redis:** REDIS_HOST, REDIS_PORT, REDIS_PASSWORD

**JWT:** JWT_SECRET, JWT_EXPIRES_IN, REFRESH_TOKEN_SECRET, REFRESH_TOKEN_EXPIRES_IN

**AWS S3:** AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION, AWS_S3_BUCKET

**SendGrid:** SENDGRID_API_KEY, FROM_EMAIL

**Twilio:** TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER

**Firebase:** FCM_SERVER_KEY

**Frontend:** FRONTEND_URL

### Project Structure
**Root:** business-chat-backend/

**src/config/:** database.js, redis.js, socketio.js

**src/controllers/:** authController, userController, messageController, announcementController, reportController

**src/middleware/:** auth, roleCheck, rateLimiter, errorHandler

**src/models/:** User, Message, Conversation, Announcement, Report

**src/routes/:** authRoutes, userRoutes, messageRoutes, announcementRoutes, reportRoutes

**src/services/:** emailService, smsService, fileUploadService, notificationService

**src/sockets/:** socketHandler, messageSocket, notificationSocket

**src/utils/:** jwt, logger, validators

**src/:** app.js, server.js

**Other:** migrations/, seeders/, tests/, .env, .env.example, .gitignore, package.json, README.md

---

## Deployment Strategy

### Option 1: Docker + Self-Hosted (Recommended)
**Docker Compose Services:**
- **app:** Node.js application on port 5000, production mode, depends on postgres and redis
- **postgres:** PostgreSQL 14 container with persistent volume
- **redis:** Redis 6 Alpine with password authentication

**Estimated Cost:** $10-20/month (VPS hosting)

---

## Monthly Cost Breakdown (Node.js Stack)

### Minimal Setup (Phase 1 - MVP)
- **Hosting:** Render/VPS - $10-20
- **Database:** PostgreSQL (included) - $0
- **Redis:** (included) - $0
- **Storage:** S3 (5GB) - $0.12
- **Email:** SendGrid (100 emails/day free) - $0
- **SMS:** Twilio (pay as you go) - ~$0.01/SMS
- **Domain:** - $12/year

**Total: ~$10-25/month**

---

### Production Setup (Phase 3+)
- **Hosting:** Render/VPS - $30-50
- **Database:** Managed PostgreSQL - $15-30
- **Redis:** Managed Redis - $10-20
- **Storage:** S3 (50GB + CDN) - $5-10
- **Email:** SendGrid (40k emails/month) - $20
- **SMS:** Twilio - ~$50/month (estimated)
- **Monitoring:** Sentry - $0-26
- **Backups:** Automated - $5

**Total: ~$135-211/month**

---

## Performance Targets

### Response Times
- API endpoints: < 200ms
- Socket.io events: < 50ms
- Database queries: < 100ms
- File uploads: < 2s (10MB file)

### Scalability Targets
- Concurrent connections: 1000+
- Messages per second: 100+
- Database connections: Pool of 20-50
- Redis memory: 256MB-1GB

### Availability
- Uptime: 99.5%+ (Phase 1), 99.9%+ (Production)
- Automatic restarts on crashes (PM2)
- Database backups: Daily
- Monitoring: Real-time error tracking

---

## Testing Strategy

### Unit Tests
- Authentication logic
- Database models
- Utility functions
- Message validation

### Integration Tests
- API endpoints
- Socket.io events
- Database transactions
- File upload flow

### Testing Tools
- **Framework:** Jest or Mocha
- **API Testing:** Supertest
- **Socket Testing:** socket.io-client
- **Coverage:** Istanbul/NYC

---

## Monitoring & Logging

### Error Tracking
- **Sentry** for production errors
- Automatic error reporting
- User context tracking
- Performance monitoring

### Logging
- Use Winston logger for structured JSON logging
- Separate error logs (error.log) and combined logs
- Log levels: error, warn, info, http, verbose, debug, silly

### Metrics to Track
- API response times
- Socket.io connection count
- Database query performance
- Memory usage
- CPU usage
- Active conversations
- Messages per minute

---

## Security Checklist

- [ ] Helmet.js for HTTP headers security
- [ ] CORS properly configured
- [ ] Rate limiting on all endpoints
- [ ] SQL injection prevention (Sequelize/Prisma ORM)
- [ ] XSS protection (sanitize inputs)
- [ ] CSRF tokens for forms
- [ ] Secure password hashing (bcrypt)
- [ ] JWT secret in environment variables
- [ ] HTTPS/SSL in production
- [ ] File upload validation and scanning
- [ ] Socket.io authentication
- [ ] Database connection pooling
- [ ] Environment variables never committed
- [ ] Regular dependency updates
- [ ] Automated security scanning (npm audit)

---

## Key Features Summary

✅ Node.js + Express backend  
✅ PostgreSQL for structured data  
✅ Socket.io for real-time messaging  
✅ JWT authentication  
✅ Role-based access control  
✅ One-to-one messaging only  
✅ Admin approval workflow  
✅ Individual media permission control  
✅ Broadcast and announcements  
✅ Business report system  
✅ Full conversation history  
✅ Auto-close inactive sessions  
✅ Real-time typing indicators  
✅ Comprehensive API documentation  
✅ Scalable architecture  

---

## Next Steps

1. **Setup Development Environment**
   - Install Node.js, PostgreSQL, Redis
   - Initialize Git repository
   - Create project structure

2. **Database Setup**
   - Create PostgreSQL database
   - Run initial migrations
   - Setup Sequelize/Prisma

3. **Core Backend Development**
   - Implement authentication
   - Build REST API endpoints
   - Setup Socket.io server

4. **Testing & Deployment**
   - Write unit and integration tests
   - Setup CI/CD pipeline
   - Deploy to Railway/DigitalOcean

5. **Frontend Development**
   - Choose frontend framework (React/Vue)
   - Implement Socket.io client
   - Build admin dashboard

---

## Resources & Documentation

**Node.js Ecosystem:**
- Express.js: https://expressjs.com/
- Socket.io: https://socket.io/docs/
- Sequelize: https://sequelize.org/
- Prisma: https://www.prisma.io/

**Deployment:**
- Render: https://render.com/

**Services:**
- SendGrid: https://sendgrid.com/
- Twilio: https://www.twilio.com/
- AWS S3: https://aws.amazon.com/s3/

**Learning Resources:**
- Node.js Best Practices: https://github.com/goldbergyoni/nodebestpractices
- Socket.io Tutorial: https://socket.io/get-started/chat
- PostgreSQL Documentation: https://www.postgresql.org/docs/