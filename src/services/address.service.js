const prisma = require('../config/db');

const MAX_ADDRESSES_PER_USER = 10;

function trimOrNull(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
}

// Address responses are decorated with the user profile so the mobile app sees
// a complete address (recipient name, phone, region) even when the row only
// stores the location bits the user typed. The address row itself stays clean —
// the user profile remains the source of truth for name/phone, and checkout
// reads the same profile to stamp orders.
function mapAddress(a, profile = {}) {
  return {
    id: a.id,
    label: a.label ?? null,
    fullName: a.fullName ?? profile.fullName ?? null,
    phone: a.phone ?? profile.phone ?? null,
    streetAddress: a.streetAddress ?? null,
    apartment: a.apartment ?? null,
    city: a.city ?? profile.addressCity ?? null,
    state: a.state ?? null,
    postalCode: a.postalCode ?? null,
    country: a.country ?? profile.addressCountry ?? null,
    isDefault: a.isDefault,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
}

// Pulls the contact + region defaults from the user profile in one read.
// fullName falls back to firstName + lastName for users created before the
// fullName migration so legacy accounts still get a populated response.
async function loadProfileDefaults(client, userId) {
  const u = await client.user.findUnique({
    where: { id: userId },
    select: {
      fullName: true,
      firstName: true,
      lastName: true,
      phone: true,
      addressCity: true,
      addressCountry: true,
    },
  });
  if (!u) return { fullName: null, phone: null, addressCity: null, addressCountry: null };
  const fullName =
    (u.fullName && u.fullName.trim())
    || [u.firstName, u.lastName].filter(Boolean).join(' ').trim()
    || null;
  return {
    fullName,
    phone: u.phone || null,
    addressCity: u.addressCity || null,
    addressCountry: u.addressCountry || null,
  };
}

async function listAddresses(userId) {
  const [rows, profile] = await Promise.all([
    prisma.address.findMany({
      where: { userId },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    }),
    loadProfileDefaults(prisma, userId),
  ]);
  return rows.map((r) => mapAddress(r, profile));
}

async function getAddressById(userId, addressId) {
  const [row, profile] = await Promise.all([
    prisma.address.findFirst({ where: { id: addressId, userId } }),
    loadProfileDefaults(prisma, userId),
  ]);
  return row ? mapAddress(row, profile) : null;
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

    const profile = await loadProfileDefaults(tx, userId);

    // Persist city/country with the profile fallback so the row carries usable
    // data even if it's later read outside the API decorator. Recipient name
    // and phone stay null on the row — the response decorator fills them from
    // the profile so they always reflect the latest user-entered values.
    const cityIn = trimOrNull(city);
    const countryIn = trimOrNull(country);
    const cityFinal = cityIn ?? profile.addressCity;
    const countryFinal = countryIn ?? profile.addressCountry;

    const row = await tx.address.create({
      data: {
        userId,
        label: trimOrNull(label),
        fullName: trimOrNull(fullName),
        phone: trimOrNull(phone),
        streetAddress: trimOrNull(streetAddress),
        apartment: trimOrNull(apartment),
        city: cityFinal,
        state: trimOrNull(state),
        postalCode: trimOrNull(postalCode),
        country: countryFinal,
        isDefault: makeDefault,
      },
    });

    return mapAddress(row, profile);
  });
}

async function updateAddress(userId, addressId, data) {
  const { label, fullName, phone, streetAddress, apartment, city, state, postalCode, country, isDefault } = data;

  const patch = {};
  if (label !== undefined) patch.label = trimOrNull(label);
  if (fullName !== undefined) patch.fullName = trimOrNull(fullName);
  if (phone !== undefined) patch.phone = trimOrNull(phone);
  if (streetAddress !== undefined) patch.streetAddress = trimOrNull(streetAddress);
  if (apartment !== undefined) patch.apartment = trimOrNull(apartment);
  if (city !== undefined) patch.city = trimOrNull(city);
  if (state !== undefined) patch.state = trimOrNull(state);
  if (postalCode !== undefined) patch.postalCode = trimOrNull(postalCode);
  if (country !== undefined) patch.country = trimOrNull(country);
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
      const [row, profile] = await Promise.all([
        tx.address.findUnique({ where: { id: addressId } }),
        loadProfileDefaults(tx, userId),
      ]);
      return row ? mapAddress(row, profile) : null;
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
      const [row, profile] = await Promise.all([
        tx.address.update({ where: { id: addressId }, data: { isDefault: true } }),
        loadProfileDefaults(tx, userId),
      ]);
      return mapAddress(row, profile);
    });
  } catch (err) {
    if (err.code === 'P2025') return null;
    throw err;
  }
}

module.exports = { listAddresses, getAddressById, createAddress, updateAddress, deleteAddress, setDefault, MAX_ADDRESSES_PER_USER };
