const prisma = require('../config/db');

function mapAddress(a) {
  return {
    id: a.id,
    label: a.label ?? null,
    fullName: a.fullName,
    phone: a.phone,
    streetAddress: a.streetAddress,
    apartment: a.apartment ?? null,
    city: a.city,
    state: a.state ?? null,
    postalCode: a.postalCode ?? null,
    country: a.country,
    isDefault: a.isDefault,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
}

async function listAddresses(userId) {
  const rows = await prisma.address.findMany({
    where: { userId },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
  });
  return rows.map(mapAddress);
}

async function getAddressById(userId, addressId) {
  const row = await prisma.address.findFirst({ where: { id: addressId, userId } });
  return row ? mapAddress(row) : null;
}

async function createAddress(userId, data) {
  const { label, fullName, phone, streetAddress, apartment, city, state, postalCode, country, isDefault } = data;

  return prisma.$transaction(async (tx) => {
    if (isDefault) {
      await tx.address.updateMany({ where: { userId }, data: { isDefault: false } });
    } else {
      // First address for this user is default automatically
      const count = await tx.address.count({ where: { userId } });
      if (count === 0) data.isDefault = true;
    }

    const row = await tx.address.create({
      data: {
        userId,
        label: label ? String(label).trim() : null,
        fullName: String(fullName).trim(),
        phone: String(phone).trim(),
        streetAddress: String(streetAddress).trim(),
        apartment: apartment ? String(apartment).trim() : null,
        city: String(city).trim(),
        state: state ? String(state).trim() : null,
        postalCode: postalCode ? String(postalCode).trim() : null,
        country: String(country).trim(),
        isDefault: data.isDefault ?? false,
      },
    });

    return mapAddress(row);
  });
}

async function updateAddress(userId, addressId, data) {
  const existing = await prisma.address.findFirst({ where: { id: addressId, userId } });
  if (!existing) return null;

  const { label, fullName, phone, streetAddress, apartment, city, state, postalCode, country, isDefault } = data;

  const patch = {};
  if (label !== undefined) patch.label = label ? String(label).trim() : null;
  if (fullName !== undefined) patch.fullName = String(fullName).trim();
  if (phone !== undefined) patch.phone = String(phone).trim();
  if (streetAddress !== undefined) patch.streetAddress = String(streetAddress).trim();
  if (apartment !== undefined) patch.apartment = apartment ? String(apartment).trim() : null;
  if (city !== undefined) patch.city = String(city).trim();
  if (state !== undefined) patch.state = state ? String(state).trim() : null;
  if (postalCode !== undefined) patch.postalCode = postalCode ? String(postalCode).trim() : null;
  if (country !== undefined) patch.country = String(country).trim();
  if (isDefault !== undefined) patch.isDefault = Boolean(isDefault);

  return prisma.$transaction(async (tx) => {
    if (patch.isDefault === true) {
      await tx.address.updateMany({ where: { userId }, data: { isDefault: false } });
    }
    const row = await tx.address.update({ where: { id: addressId }, data: patch });
    return mapAddress(row);
  });
}

async function deleteAddress(userId, addressId) {
  const existing = await prisma.address.findFirst({ where: { id: addressId, userId } });
  if (!existing) return false;

  await prisma.$transaction(async (tx) => {
    await tx.address.delete({ where: { id: addressId } });
    // If this was the default, promote the most recent remaining address
    if (existing.isDefault) {
      const next = await tx.address.findFirst({
        where: { userId },
        orderBy: { createdAt: 'desc' },
      });
      if (next) await tx.address.update({ where: { id: next.id }, data: { isDefault: true } });
    }
  });

  return true;
}

async function setDefault(userId, addressId) {
  const existing = await prisma.address.findFirst({ where: { id: addressId, userId } });
  if (!existing) return null;

  return prisma.$transaction(async (tx) => {
    await tx.address.updateMany({ where: { userId }, data: { isDefault: false } });
    const row = await tx.address.update({ where: { id: addressId }, data: { isDefault: true } });
    return mapAddress(row);
  });
}

module.exports = { listAddresses, getAddressById, createAddress, updateAddress, deleteAddress, setDefault };
