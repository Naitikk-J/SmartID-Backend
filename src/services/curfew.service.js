
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const DEFAULT_CURFEW_RULES = [
    { studentType: 'DAY_SCHOLAR', startTime: '21:00', endTime: '06:00', isActive: true },
    { studentType: 'HOSTELLER_BOYS', startTime: '21:00', endTime: '06:00', isActive: true },
    { studentType: 'HOSTELLER_GIRLS', startTime: '21:00', endTime: '06:00', isActive: true },
];

async function getCurfewRules() {
    let rules = await prisma.curfewRule.findMany({
        orderBy: {
            updatedAt: 'desc'
        }
    });

    // Bootstrap defaults once so the admin UI always has editable rows.
    if (!rules.length) {
        await Promise.all(
            DEFAULT_CURFEW_RULES.map((rule) => prisma.curfewRule.create({ data: rule }))
        );

        rules = await prisma.curfewRule.findMany({
            orderBy: {
                updatedAt: 'desc'
            }
        });
    }

    return rules;
}

async function getCurfewRuleById(id) {
    return await prisma.curfewRule.findUnique({
        where: { id },
    });
}

async function createCurfewRule(data) {
    return await prisma.curfewRule.create({
        data,
    });
}

async function updateCurfewRule(id, data) {
    return await prisma.curfewRule.update({
        where: { id },
        data,
    });
}

async function deleteCurfewRule(id) {
    return await prisma.curfewRule.delete({
        where: { id },
    });
}

module.exports = {
    getCurfewRules,
    getCurfewRuleById,
    createCurfewRule,
    updateCurfewRule,
    deleteCurfewRule,
};
