import { PrismaClient } from '@prisma/client'

import { randomBytes, pbkdf2 } from 'crypto'

export async function hashPassword(password: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const salt = randomBytes(16).toString('hex');
    pbkdf2(password, salt, 1000, 64, 'sha512', (err, derivedKey) => {
      if (err) reject(err);
      resolve('pbkdf2:' + salt + ':' + derivedKey.toString('hex'));
    });
  });
}

const prisma = new PrismaClient();

function generateRandomPassword(length = 16): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*';
  let password = '';
  const bytes = randomBytes(length);
  for (let i = 0; i < length; i++) {
    password += chars[bytes[i] % chars.length];
  }
  return password;
}

async function main() {
  try {
    const passwordPlain = generateRandomPassword();
    const password = await hashPassword(passwordPlain)
    const accounts = await prisma.accounts.findFirst({
      where: { role: 'superadmin' }
    })
    if (!accounts) {
      console.error('No superadmin account found.')
      process.exit(1)
    }
    await prisma.accounts.update({
      where: { id: accounts.id },
      data: { password }
    })
    console.log("✨ Reset password done! ✨")
    console.log("New password:", passwordPlain)
    console.log("Please change this password immediately after login.")
  } catch (error) {
    console.error(error)
    process.exit(1)
  }
}

main()
  .then(() => {
    process.exit(0)
  })
  .catch((e) => {
    console.error(e);
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
