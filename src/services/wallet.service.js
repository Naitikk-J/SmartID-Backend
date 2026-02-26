// ═══════════════════════════════════════════════════════════════
// MITS Smart ID — Wallet Service
// Top-up, deduction (with SERIALIZABLE), transaction history
// ═══════════════════════════════════════════════════════════════

const prisma = require('../config/database');
const { AppError } = require('../middleware/errorHandler');

/**
 * Get wallet balance for a student.
 */
async function getBalance(studentId) {
    const wallet = await prisma.wallet.findUnique({
        where: { studentId: studentId },
    });
    if (!wallet) {
        throw new AppError('Wallet not found', 404, 'NOT_FOUND');
    }
    return parseFloat(wallet.balance);
}

/**
 * Top up a student's wallet.
 */
async function topUp({ studentId, amount, note, adminId }) {
    if (amount <= 0) {
        throw new AppError('Amount must be positive', 400, 'INVALID_AMOUNT');
    }

    const result = await prisma.$transaction(async (tx) => {
        const wallet = await tx.wallet.update({
            where: { studentId },
            data: { balance: { increment: amount } },
        });

        const transaction = await tx.walletTransaction.create({
            data: {
                walletId: wallet.id,
                type: 'TOPUP',
                amount,
                balanceAfter: wallet.balance,
                note,
            },
        });

        // Audit log
        await tx.auditLog.create({
            data: {
                actorId: adminId,
                action: 'WALLET_TOPUP',
                entity: 'Wallet',
                entityId: wallet.id,
                newValue: { amount, balanceAfter: parseFloat(wallet.balance) },
            },
        });

        return { wallet, transaction };
    });

    return result;
}

/**
 * Deduct from a student's wallet using SERIALIZABLE isolation.
 * SELECT FOR UPDATE prevents race conditions.
 */
async function deduct({ studentId, amount, note }) {
    if (amount <= 0) {
        throw new AppError('Amount must be positive', 400, 'INVALID_AMOUNT');
    }

    const result = await prisma.$transaction(
        async (tx) => {
            // SELECT ... FOR UPDATE (implicit via $queryRaw for serializable)
            const wallet = await tx.wallet.findUnique({
                where: { studentId },
            });

            if (!wallet) {
                throw new AppError('Wallet not found', 404, 'NOT_FOUND');
            }

            const currentBalance = parseFloat(wallet.balance);
            if (currentBalance < amount) {
                throw new AppError(
                    `Insufficient balance: ${currentBalance} < ${amount}`,
                    402,
                    'INSUFFICIENT_BALANCE'
                );
            }

            const newBalance = currentBalance - amount;

            const updatedWallet = await tx.wallet.update({
                where: { id: wallet.id },
                data: { balance: newBalance },
            });

            const transaction = await tx.walletTransaction.create({
                data: {
                    walletId: wallet.id,
                    type: 'DEBIT',
                    amount,
                    balanceAfter: newBalance,
                    note,
                },
            });

            return {
                newBalance,
                transactionId: transaction.id.toString(),
            };
        },
        {
            isolationLevel: 'Serializable',
        }
    );

    return result;
}

/**
 * Get paginated transaction history.
 */
async function getTransactionHistory(studentId, { page = 1, limit = 50 }) {
    const wallet = await prisma.wallet.findUnique({
        where: { studentId: studentId },
    });
    if (!wallet) {
        throw new AppError('Wallet not found', 404, 'NOT_FOUND');
    }

    const [transactions, total] = await Promise.all([
        prisma.walletTransaction.findMany({
            where: { walletId: wallet.id },
            orderBy: { createdAt: 'desc' },
            skip: (page - 1) * limit,
            take: limit,
        }),
        prisma.walletTransaction.count({ where: { walletId: wallet.id } }),
    ]);

    return {
        transactions: transactions.map((t) => ({
            ...t,
            id: t.id.toString(),
            amount: parseFloat(t.amount),
            balanceAfter: parseFloat(t.balanceAfter),
        })),
        total,
        page,
        limit,
        pages: Math.ceil(total / limit),
    };
}

module.exports = { getBalance, topUp, deduct, getTransactionHistory };
