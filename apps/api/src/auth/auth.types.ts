import type { Request } from "express";

export interface Account {
  id: string;
  email: string;
  name: string;
  createdAt: Date;
}

export interface AuthRequest extends Request {
  user: Account;
  sessionId: string;
}

export const accountSelect = {
  id: true,
  email: true,
  name: true,
  createdAt: true,
} as const;
export const AUTH_COOKIE = "efiemipeg_session";
export const JWT_ISSUER = "efiemipeg-api";
export const JWT_AUDIENCE = "efiemipeg-web";
