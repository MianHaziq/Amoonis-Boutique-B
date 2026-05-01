const prisma = require('../config/db');

const MAX_ADDRESSES_PER_USER = 10;

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
  const { label, fullName, phone, streetAddress, apartment, city, state, postalCode, country } = data;
  let makeDefault = Boolean(data.isDefault);

  return prisma.$transaction(async (tx) => {
    const existingCount = await tx.address.count({ where: { userId } });
    if (existingCount >= MAX_ADDRESSES_PER_USER) {
      const err = new Error(`You can save up to ${MAX_ADDRESSES_PER_USER} addresses`);
      err.code = 'ADDRESS_LIMIT_REACHED';
      throw err;
    }

    if (existingCount === 0) makeDefault = true;
    if (makeDefault) {
      await tx.address.updateMany({ where: { userId }, data: { isDefault: false } });
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
        isDefault: makeDefault,
      },
    });

    return mapAddress(row);
  });
}

async function updateAddress(userId, addressId, data) {
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

  if (Object.keys(patch).length === 0) return null;

  try {
    return await prisma.$transaction(async (tx) => {
      if (patch.isDefault === true) {
        await tx.address.updateMany({ where: { userId }, data: { isDefault: false } });
      }
      // updateMany filters by both id AND userId — clean ownership, no TOCTOU
      const result = await tx.address.updateMany({
        where: { id: addressId, userId },
        data: patch,
      });
      if (result.count === 0) return null;
      const row = await tx.address.findUnique({ where: { id: addressId } });
      return row ? mapAddress(row) : null;
    });
  } catch (err) {
    if (err.code === 'P2025') return null;
    throw err;
  }
}

async function deleteAddress(userId, addressId) {
  try {
    return await prisma.$transaction(async (tx) => {
      const existing = await tx.address.findFirst({
        where: { id: addressId, userId },
        select: { id: true, isDefault: true },
      });
      if (!existing) return false;

      await tx.address.delete({ where: { id: addressId } });

      if (existing.isDefault) {
        const next = await tx.address.findFirst({
          where: { userId },
          orderBy: { createdAt: 'desc' },
          select: { id: true },
        });
        if (next) await tx.address.update({ where: { id: next.id }, data: { isDefault: true } });
      }

      return true;
    });
  } catch (err) {
    if (err.code === 'P2025') return false;
    throw err;
  }
}

async function setDefault(userId, addressId) {
  try {
    return await prisma.$transaction(async (tx) => {
      const existing = await tx.address.findFirst({
        where: { id: addressId, userId },
        select: { id: true },
      });
      if (!existing) return null;

      await tx.address.updateMany({ where: { userId }, data: { isDefault: false } });
      const row = await tx.address.update({ where: { id: addressId }, data: { isDefault: true } });
      return mapAddress(row);
    });
  } catch (err) {
    if (err.code === 'P2025') return null;
    throw err;
  }
}

module.exports = { listAddresses, getAddressById, createAddress, updateAddress, deleteAddress, setDefault, MAX_ADDRESSES_PER_USER };
