// src/services/pharmacy/medicationService.js
// Migrated from raw pg to Prisma ORM

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';

export const getAllMedications = async (filters) => {
  const { page, limit, search, category, in_stock } = filters;
  const offset = (page - 1) * limit;

  // Build dynamic where for Prisma
  const where = { is_active: true };
  if (category) where.category = category;
  if (in_stock === 'true') where.stock_quantity = { gt: 0 };
  else if (in_stock === 'false') where.stock_quantity = 0;
  if (search) {
    where.OR = [
      { name: { contains: search, mode: 'insensitive' } },
      { generic_name: { contains: search, mode: 'insensitive' } },
    ];
  }

  const [total, medications] = await prisma.$transaction([
    prisma.medications.count({ where }),
    prisma.medications.findMany({
      where,
      select: {
        id: true, name: true, generic_name: true, brand: true,
        category: true, dosage: true, form: true, price: true,
        stock_quantity: true, expiry_date: true, manufacturer: true,
        prescription_required: true, is_active: true, created_at: true,
      },
      orderBy: { name: 'asc' },
      skip: offset,
      take: limit,
    }),
  ]);

  return {
    medications,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      hasNext: page * limit < total,
      hasPrev: page > 1,
    },
    filters: {
      search: search || null,
      category: category || null,
      in_stock: in_stock || null,
    },
  };
};

export const getMedicationById = async (id) => {
  const rows = await prisma.$queryRaw`
    SELECT m.*,
           TO_CHAR(m.expiry_date, 'DD-MM-YYYY') AS expiry_date_formatted,
           TO_CHAR(m.created_at, 'DD-MM-YYYY HH24:MI') AS created_at_formatted,
           CASE
             WHEN m.expiry_date < CURRENT_DATE THEN 'EXPIRED'
             WHEN m.expiry_date < CURRENT_DATE + INTERVAL '30 days' THEN 'EXPIRING_SOON'
             ELSE 'VALID'
           END AS expiry_status,
           CASE
             WHEN m.stock_quantity = 0 THEN 'OUT_OF_STOCK'
             WHEN m.stock_quantity < 10 THEN 'LOW_STOCK'
             ELSE 'IN_STOCK'
           END AS stock_status
    FROM medications m
    WHERE m.id = ${parseInt(id)} AND m.is_active = true
  `;
  return rows.length > 0 ? rows[0] : null;
};

export const getMedicationsByCategory = async (category, inStockOnly) => {
  const where = { category, is_active: true };
  if (inStockOnly) where.stock_quantity = { gt: 0 };

  const medications = await prisma.medications.findMany({
    where,
    select: {
      id: true, name: true, generic_name: true, brand: true,
      dosage: true, form: true, price: true,
      stock_quantity: true, expiry_date: true, prescription_required: true,
    },
    orderBy: { name: 'asc' },
  });

  return { medications, count: medications.length, category, in_stock_only: inStockOnly };
};

export const searchMedications = async (searchParams) => {
  const { q, category, prescription_required, min_price, max_price, in_stock_only } = searchParams;

  const where = { is_active: true };
  if (category) where.category = category;
  if (prescription_required !== undefined) where.prescription_required = prescription_required === 'true';
  if (min_price) where.price = { ...(where.price || {}), gte: parseFloat(min_price) };
  if (max_price) where.price = { ...(where.price || {}), lte: parseFloat(max_price) };
  if (in_stock_only) where.stock_quantity = { gt: 0 };
  if (q) {
    where.OR = [
      { name: { contains: q, mode: 'insensitive' } },
      { generic_name: { contains: q, mode: 'insensitive' } },
      { brand: { contains: q, mode: 'insensitive' } },
    ];
  }

  const medications = await prisma.medications.findMany({
    where,
    select: {
      id: true, name: true, generic_name: true, brand: true,
      category: true, dosage: true, form: true, price: true,
      stock_quantity: true, prescription_required: true, expiry_date: true,
    },
    orderBy: { name: 'asc' },
    take: 50,
  });

  return {
    medications,
    count: medications.length,
    search_params: {
      query: q || null,
      category: category || null,
      prescription_required: prescription_required || null,
      price_range: { min: min_price || null, max: max_price || null },
      in_stock_only,
    },
  };
};

export const createMedication = async (medicationData) => {
  const {
    name, generic_name, brand, category, dosage, form,
    price, stock_quantity, expiry_date, manufacturer,
    prescription_required = false, description, createdBy,
  } = medicationData;

  const existing = await prisma.medications.findFirst({
    where: { name, generic_name },
    select: { id: true },
  });
  if (existing) return null;

  const med = await prisma.medications.create({
    data: {
      name, generic_name: generic_name || null, brand: brand || null,
      category: category || null, dosage: dosage || null, form: form || null,
      price: price ?? null, stock_quantity: stock_quantity ?? null,
      expiry_date: expiry_date ? new Date(expiry_date) : null,
      manufacturer: manufacturer || null,
      prescription_required,
      description: description || null,
      is_active: true,
      created_by: createdBy || null,
    },
    select: {
      id: true, name: true, generic_name: true, category: true,
      stock_quantity: true, price: true, created_at: true,
    },
  });

  logger.info(`Medication created: ${name} by ${createdBy}`);
  return med;
};

export const updateMedication = async (id, updateData) => {
  const {
    name, generic_name, brand, category, dosage, form,
    price, stock_quantity, expiry_date, manufacturer,
    prescription_required, description, updatedBy,
  } = updateData;

  const existing = await prisma.medications.findUnique({
    where: { id: parseInt(id) },
    select: { id: true, is_active: true },
  });
  if (!existing || !existing.is_active) return null;

  const med = await prisma.medications.update({
    where: { id: parseInt(id) },
    data: {
      ...(name !== undefined && { name }),
      ...(generic_name !== undefined && { generic_name }),
      ...(brand !== undefined && { brand }),
      ...(category !== undefined && { category }),
      ...(dosage !== undefined && { dosage }),
      ...(form !== undefined && { form }),
      ...(price !== undefined && { price }),
      ...(stock_quantity !== undefined && { stock_quantity }),
      ...(expiry_date !== undefined && { expiry_date: new Date(expiry_date) }),
      ...(manufacturer !== undefined && { manufacturer }),
      ...(prescription_required !== undefined && { prescription_required }),
      ...(description !== undefined && { description }),
      updated_at: new Date(),
    },
    select: {
      id: true, name: true, generic_name: true, category: true,
      stock_quantity: true, price: true, created_at: true, updated_at: true,
    },
  });

  logger.info(`Medication ${id} updated by ${updatedBy}`);
  return med;
};

export const deleteMedication = async (id, deletedBy) => {
  const existing = await prisma.medications.findUnique({
    where: { id: parseInt(id) },
    select: { id: true, is_active: true },
  });
  if (!existing || !existing.is_active) return null;

  const med = await prisma.medications.update({
    where: { id: parseInt(id) },
    data: { is_active: false, updated_at: new Date() },
    select: { name: true, generic_name: true },
  });

  logger.info(`Medication ${id} soft deleted by ${deletedBy}`);
  return med;
};

export const updateStock = async (id, quantity, operation, updatedBy) => {
  let rows;
  const qty = parseFloat(quantity);
  const idInt = parseInt(id);

  if (operation === 'add') {
    rows = await prisma.$queryRaw`
      UPDATE medications
      SET stock_quantity = stock_quantity + ${qty}, updated_at = NOW()
      WHERE id = ${idInt}
      RETURNING id, name, generic_name, category, stock_quantity, price, created_at, updated_at
    `;
  } else if (operation === 'subtract') {
    rows = await prisma.$queryRaw`
      UPDATE medications
      SET stock_quantity = GREATEST(stock_quantity - ${qty}, 0), updated_at = NOW()
      WHERE id = ${idInt}
      RETURNING id, name, generic_name, category, stock_quantity, price, created_at, updated_at
    `;
  } else {
    rows = await prisma.$queryRaw`
      UPDATE medications
      SET stock_quantity = ${qty}, updated_at = NOW()
      WHERE id = ${idInt}
      RETURNING id, name, generic_name, category, stock_quantity, price, created_at, updated_at
    `;
  }

  if (rows.length === 0) return null;

  logger.info(`Stock updated for medication ${id}: ${operation} ${quantity} by ${updatedBy}`);
  return {
    id: rows[0].id,
    name: rows[0].name,
    stock_quantity: rows[0].stock_quantity,
    operation,
    quantity_changed: quantity,
  };
};
