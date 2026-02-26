// ═══════════════════════════════════════════════════════════════
// MITS Smart ID — Library Service
// Book issue, return, fine calculation
// ═══════════════════════════════════════════════════════════════

const prisma = require('../config/database');
const { AppError } = require('../middleware/errorHandler');

const LOAN_DAYS = 14;
const FINE_PER_DAY = 2; // Rs 2 per day

/**
 * Issue a book to a student.
 */
async function issueBook({ studentId, bookQrCode }) {
    // Check for overdue books
    const now = new Date();
    const overdueBooks = await prisma.libraryTransaction.findMany({
        where: {
            studentId,
            returnedAt: null,
            dueAt: { lt: now },
        },
        include: { book: { select: { title: true, qrCode: true } } },
    });

    if (overdueBooks.length > 0) {
        throw new AppError('Student has overdue books', 400, 'OUTSTANDING_DUES');
    }

    // Find book
    const book = await prisma.book.findUnique({
        where: { qrCode: bookQrCode },
    });
    if (!book) {
        throw new AppError('Book not found', 404, 'NOT_FOUND');
    }
    if (book.availableCopies <= 0) {
        throw new AppError('No copies available', 400, 'BOOK_UNAVAILABLE');
    }

    // Calculate due date (14 days from now)
    const dueAt = new Date(now);
    dueAt.setDate(dueAt.getDate() + LOAN_DAYS);

    // Create transaction and decrement available copies
    const [transaction] = await prisma.$transaction([
        prisma.libraryTransaction.create({
            data: {
                studentId,
                bookId: book.id,
                dueAt,
            },
            include: { book: true },
        }),
        prisma.book.update({
            where: { id: book.id },
            data: { availableCopies: { decrement: 1 } },
        }),
    ]);

    return transaction;
}

/**
 * Return a book from a student.
 */
async function returnBook({ studentId, bookQrCode }) {
    const book = await prisma.book.findUnique({
        where: { qrCode: bookQrCode },
    });
    if (!book) {
        throw new AppError('Book not found', 404, 'NOT_FOUND');
    }

    // Find open transaction
    const transaction = await prisma.libraryTransaction.findFirst({
        where: {
            studentId,
            bookId: book.id,
            returnedAt: null,
        },
    });
    if (!transaction) {
        throw new AppError('No open borrow found for this student and book', 404, 'TRANSACTION_NOT_FOUND');
    }

    // Calculate fine
    const now = new Date();
    let fineAmount = 0;
    if (now > transaction.dueAt) {
        const overdueDays = Math.ceil((now - transaction.dueAt) / (1000 * 60 * 60 * 24));
        fineAmount = overdueDays * FINE_PER_DAY;
    }

    // Update transaction and increment copies
    const [updatedTransaction] = await prisma.$transaction([
        prisma.libraryTransaction.update({
            where: { id: transaction.id },
            data: { returnedAt: now, fineAmount },
            include: { book: true },
        }),
        prisma.book.update({
            where: { id: book.id },
            data: { availableCopies: { increment: 1 } },
        }),
    ]);

    return updatedTransaction;
}

/**
 * Get a student's borrow history.
 */
async function getStudentBorrowHistory(studentId) {
    return prisma.libraryTransaction.findMany({
        where: { studentId },
        include: { book: true },
        orderBy: { issuedAt: 'desc' },
    });
}

/**
 * Get all overdue (unreturned, past-due) transactions.
 */
async function getOverdueList() {
    return prisma.libraryTransaction.findMany({
        where: {
            returnedAt: null,
            dueAt: { lt: new Date() },
        },
        include: {
            student: { select: { id: true, fullName: true, enrollmentNo: true, department: true } },
            book: true,
        },
        orderBy: { dueAt: 'asc' },
    });
}

/**
 * Get paginated book list with availability.
 */
async function getBooks({ page = 1, limit = 50, search }) {
    const where = {};
    if (search) {
        where.OR = [
            { title: { contains: search, mode: 'insensitive' } },
            { author: { contains: search, mode: 'insensitive' } },
            { isbn: { contains: search, mode: 'insensitive' } },
        ];
    }

    const [books, total] = await Promise.all([
        prisma.book.findMany({
            where,
            orderBy: { title: 'asc' },
            skip: (page - 1) * limit,
            take: limit,
        }),
        prisma.book.count({ where }),
    ]);

    return { books, total, page, limit, pages: Math.ceil(total / limit) };
}

/**
 * Add a new book.
 */
async function addBook(data) {
    return prisma.book.create({ data });
}

module.exports = {
    issueBook,
    returnBook,
    getStudentBorrowHistory,
    getOverdueList,
    getBooks,
    addBook,
};
