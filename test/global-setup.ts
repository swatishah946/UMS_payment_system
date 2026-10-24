import { execSync } from 'child_process';
import { PrismaClient } from '@prisma/client';

// creates the test database (if needed) and applies all migrations to it
export default async function globalSetup() {
  const testUrl =
    process.env.DATABASE_URL_TEST ?? 'postgresql://ums:ums@localhost:5433/ums_payments_test';
  const dbName = new URL(testUrl).pathname.slice(1);
  const adminUrl = testUrl.replace(`/${dbName}`, '/postgres');

  const admin = new PrismaClient({ datasources: { db: { url: adminUrl } } });
  const rows = await admin.$queryRaw<
    unknown[]
  >`SELECT 1 FROM pg_database WHERE datname = ${dbName}`;
  if (rows.length === 0) {
    await admin.$executeRawUnsafe(`CREATE DATABASE "${dbName}"`);
  }
  await admin.$disconnect();

  execSync('npx prisma migrate deploy', {
    env: { ...process.env, DATABASE_URL: testUrl },
    stdio: 'ignore',
  });
}
