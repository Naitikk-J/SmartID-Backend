const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

function resolveDirection(scanEvent) {
    const metadataDirection = scanEvent?.metadata?.direction;
    if (metadataDirection === 'ENTRY' || metadataDirection === 'EXIT') return metadataDirection;

    const metadataEventType = scanEvent?.metadata?.event_type;
    if (metadataEventType === 'ENTRY' || metadataEventType === 'EXIT') return metadataEventType;

    if (scanEvent?.scanType === 'GATE_ENTRY') return 'ENTRY';
    if (scanEvent?.scanType === 'GATE_EXIT') return 'EXIT';
    return null;
}

async function main() {
    console.log('Backfilling scan direction metadata...');

    const scanEvents = await prisma.scanEvent.findMany({
        select: {
            id: true,
            scanType: true,
            metadata: true,
        },
    });

    let updated = 0;

    for (const event of scanEvents) {
        const direction = resolveDirection(event);
        if (!direction) continue;

        const currentDirection = event?.metadata?.direction;
        if (currentDirection === direction) continue;

        await prisma.scanEvent.update({
            where: { id: event.id },
            data: {
                metadata: {
                    ...(event.metadata || {}),
                    direction,
                },
            },
        });

        updated += 1;
    }

    console.log(`Updated ${updated} scan events with normalized direction metadata.`);
}

main()
    .catch((error) => {
        console.error('Backfill failed:', error);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
