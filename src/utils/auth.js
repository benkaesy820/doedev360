import { SignJWT, jwtVerify } from 'jose';
import config from '../config/index.js';

const JWT_SECRET = new TextEncoder().encode(config.jwt.secret);
const REFRESH_SECRET = new TextEncoder().encode(config.jwt.refreshSecret);

export async function generateTokens(user) {
  const payload = {
    userId: user.id,
    email: user.email,
    role: user.role,
    status: user.status
  };

  const accessToken = await new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(config.jwt.expiresIn)
    .sign(JWT_SECRET);

  const refreshToken = await new SignJWT({ userId: user.id })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(config.jwt.refreshExpiresIn)
    .sign(REFRESH_SECRET);

  return { accessToken, refreshToken };
}

export async function verifyAccessToken(token) {
  try {
    const { payload } = await jwtVerify(token, JWT_SECRET);
    return payload;
  } catch (error) {
    throw new Error('Invalid access token');
  }
}

export async function verifyRefreshToken(token) {
  try {
    const { payload } = await jwtVerify(token, REFRESH_SECRET);
    return payload;
  } catch (error) {
    throw new Error('Invalid refresh token');
  }
}
