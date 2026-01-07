# EVmessages

A controlled business-to-customer chat platform where access is gated by admin approval. All conversations are one-to-one between customers and the business.

## Features

- **User Registration & Access Control** - Admin approval workflow with user statuses
- **Real-time Messaging** - Socket.io powered 1:1 chats with typing indicators
- **Media Permission System** - Admin-controlled per-user media sharing
- **Announcements/Broadcasts** - Send updates to all or selected users
- **Business Reports** - Transaction issue reporting system
- **Admin Dashboard** - User management, message monitoring, report handling

## Tech Stack

- **Backend:** Node.js + Express + Socket.io
- **Database:** PostgreSQL with Prisma
- **Cache/Sessions:** Redis
- **Authentication:** JWT + bcrypt
- **File Storage:** AWS S3 or Cloudinary
- **Notifications:** SendGrid (Email), Twilio (SMS), FCM (Push)

## Getting Started

```bash
# Install dependencies
npm install

# Set up environment variables
cp .env.example .env

# Run database migrations
npx prisma migrate dev

# Start development server
npm run dev
```

## Documentation

See [business_chat_spec.md](./business_chat_spec.md) for the full technical specification.

## License

Private - All rights reserved
