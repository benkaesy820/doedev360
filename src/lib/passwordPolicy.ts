import { z } from 'zod'

export const passwordSchema = z.string().min(8).max(100)
  .refine(v => /[a-z]/.test(v), 'Must include lowercase')
  .refine(v => /[A-Z]/.test(v), 'Must include uppercase')
  .refine(v => /\d/.test(v), 'Must include number')
  .refine(v => /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(v), 'Must include special character')
  .refine(v => !/\s/.test(v), 'Cannot contain spaces')
