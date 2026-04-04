const bcrypt = require('bcryptjs');
require('dotenv').config();

const prisma = require('../src/config/db');

async function main() {
  const hashedPassword = await bcrypt.hash('Admin@123', 12);

  const admin = await prisma.user.upsert({
    where: { email: 'admin@example.com' },
    update: {},
    create: {
      email: 'admin@example.com',
      firstName: 'Admin',
      lastName: 'User',
      password: hashedPassword,
      role: 'ADMIN',
      status: 'ACTIVE',
      isEmailVerified: true,
    },
  });

  console.log('Admin user created:', admin.email);

  await prisma.settings.upsert({
    where: { id: 'default' },
    update: { siteName: 'Amoon Bloom' },
    create: {
      id: 'default',
      siteName: 'Amoon Bloom',
      contactEmail: 'contact@example.com',
      supportEmail: 'support@example.com',
      currency: 'USD',
    },
  });

  console.log('Default settings ensured.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
