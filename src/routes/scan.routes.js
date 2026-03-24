// ═══════════════════════════════════════════════════════════════
// MITS Smart ID — Scan Routes
// POST /verify — the core scanning endpoint
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const { z } = require('zod');
const { authenticate, requireRole } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { scanRateLimit } = require('../middleware/rateLimit');
const scanService = require('../services/scan.service');
const faceAiService = require('../services/faceAi.service');
const prisma = require('../config/database');
const { AppError } = require('../middleware/errorHandler');

const router = express.Router();
const MONGODB_OBJECT_ID_REGEX = /^[a-f\d]{24}$/i;

const verifyScanSchema = z.object({
    rawToken: z.string().min(1, 'QR token required'),
    gpsLat: z.union([z.string(), z.number()]).optional().nullable(),
    gpsLng: z.union([z.string(), z.number()]).optional().nullable(),
    scanType: z.enum([
        'GATE_ENTRY', 'GATE_EXIT', 'ATTENDANCE', 'LIBRARY_ISSUE',
        'LIBRARY_RETURN', 'MESS', 'CANTEEN_PAYMENT', 'EVENT_CHECKIN',
        'HEALTH_VIEW', 'VOTE_CAST',
    ]),
    gateId: z.string().optional().nullable(),
    metadata: z.record(z.any()).optional().nullable(),
});

// POST /verify
router.post(
    '/verify',
    authenticate,
    requireRole('SECURITY_GUARD', 'HOD', 'SUPER_ADMIN', 'FACULTY', 'WARDEN'),
    scanRateLimit,
    validate(verifyScanSchema),
    async (req, res, next) => {
        try {
            const result = await scanService.verifyScan({
                rawToken: req.body.rawToken,
                gpsLat: req.body.gpsLat,
                gpsLng: req.body.gpsLng,
                scanType: req.body.scanType,
                operatorId: req.user.id,
                gateId: req.body.gateId,
                metadata: req.body.metadata || {},
            });

            res.json({ success: true, data: result });
        } catch (err) {
            next(err);
        }
    }
);

// GET /recent
router.get(
    '/recent',
    authenticate,
    requireRole('SECURITY_GUARD', 'HOD', 'SUPER_ADMIN', 'FACULTY', 'WARDEN'),
    async (req, res, next) => {
        try {
            const { date, page, limit, studentType, direction, search } = req.query;

            const requestedType = String(studentType || '').toUpperCase();
            const isHostellerFeed = requestedType === 'HOSTELLER';

            if (isHostellerFeed) {
                const currentPage = page ? parseInt(page) : 1;
                const currentLimit = limit ? parseInt(limit) : 50;

                const where = {
                    student: {
                        studentType: {
                            in: ['HOSTELLER_BOYS', 'HOSTELLER_GIRLS'],
                        },
                    },
                };

                if (date) {
                    const start = new Date(date);
                    start.setHours(0, 0, 0, 0);
                    const end = new Date(date);
                    end.setHours(23, 59, 59, 999);
                    where.timestamp = { gte: start, lte: end };
                }

                if (direction && ['ENTRY', 'EXIT'].includes(String(direction).toUpperCase())) {
                    where.direction = String(direction).toUpperCase();
                }

                if (search) {
                    const value = String(search).trim();
                    if (value) {
                        where.student.OR = [
                            { fullName: { contains: value, mode: 'insensitive' } },
                            { enrollmentNo: { contains: value, mode: 'insensitive' } },
                        ];
                    }
                }

                const [logs, total] = await Promise.all([
                    prisma.faceDetectionLog.findMany({
                        where,
                        orderBy: { timestamp: 'desc' },
                        skip: (currentPage - 1) * currentLimit,
                        take: currentLimit,
                        include: {
                            student: {
                                select: {
                                    id: true,
                                    fullName: true,
                                    enrollmentNo: true,
                                    studentType: true,
                                },
                            },
                        },
                    }),
                    prisma.faceDetectionLog.count({ where }),
                ]);

                return res.json({
                    success: true,
                    data: {
                        events: logs.map((log) => ({
                            id: log.id,
                            student: log.student,
                            studentName: log.student?.fullName,
                            enrollmentNo: log.student?.enrollmentNo,
                            studentType: log.student?.studentType,
                            direction: log.direction,
                            confidence: log.confidence,
                            scannedAt: log.timestamp,
                            gateName: log.source || 'Hosteller Face Gate',
                            result: 'VERIFIED',
                            scanType: 'HOSTELLER_FACE',
                        })),
                        total,
                        pages: Math.ceil(total / currentLimit),
                        page: currentPage,
                        limit: currentLimit,
                        source: 'HOSTELLER_LOGS',
                    },
                });
            }

            const result = await scanService.getRecentScans({
                date,
                page: page ? parseInt(page) : 1,
                limit: limit ? parseInt(limit) : 50,
                direction,
                search,
                studentType,
            });
            res.json({ success: true, data: result });
        } catch (err) {
            next(err);
        }
    }
);

// GET /export
router.get(
    '/export',
    authenticate,
    requireRole('SECURITY_GUARD', 'HOD', 'SUPER_ADMIN', 'FACULTY', 'WARDEN'),
    async (req, res, next) => {
        try {
            const { date } = req.query;
            const csv = await scanService.exportScans({ date });

            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', `attachment; filename=scan_logs_${date || 'all'}.csv`);
            res.send(csv);
        } catch (err) {
            next(err);
        }
    }
);

// ── POST /face-match — Find matching students by face descriptor ──
const faceMatchSchema = z.object({
    faceDescriptor: z.array(z.number()).min(128).optional(),
    imageFrame: z.string().optional(),
    streamId: z.string().optional(),
}).refine((payload) => Boolean(payload.faceDescriptor) || Boolean(payload.imageFrame), {
    message: 'faceDescriptor or imageFrame is required',
});

const faceExtractSchema = z.object({
    imageFrame: z.string().min(1),
    streamId: z.string().optional(),
});

router.post(
    '/face-extract',
    authenticate,
    requireRole('SECURITY_GUARD', 'HOD', 'SUPER_ADMIN', 'FACULTY', 'WARDEN'),
    validate(faceExtractSchema),
    async (req, res, next) => {
        try {
            const { imageFrame, streamId } = req.body;

            const normalizeBbox = (bbox) => {
                if (!Array.isArray(bbox) || bbox.length < 4) return null;
                const [x1, y1, x2, y2] = bbox;
                const normalized = [Number(x1), Number(y1), Number(x2), Number(y2)];
                if (normalized.some((value) => Number.isNaN(value))) return null;
                return normalized;
            };

            try {
                const extraction = await faceAiService.extractDescriptor(imageFrame, streamId || 'default');
                const extractionFaces = Array.isArray(extraction?.trackedFaces) ? extraction.trackedFaces : [];

                const trackedFaces = extractionFaces
                    .map((face, index) => ({
                        index,
                        trackId: typeof face?.trackId === 'number' ? face.trackId : null,
                        bbox: normalizeBbox(face?.bbox),
                        isLive: face?.isLive !== false,
                        antiSpoofScore: Number(face?.antiSpoofScore || 0),
                        detScore: Number(face?.detScore || 0),
                        confidence: Math.round(Number(face?.detScore || 0) * 100),
                    }))
                    .filter((face) => Array.isArray(face.bbox));

                return res.json({
                    success: true,
                    data: {
                        detectedFaces: Number(extraction?.faceCount || trackedFaces.length || 0),
                        detectedPersons: Number(extraction?.faceCount || trackedFaces.length || 0),
                        trackedFaces,
                        antiSpoofing: {
                            isLive: extraction?.isLive !== false,
                            score: Number(extraction?.antiSpoofScore || 0),
                        },
                    },
                });
            } catch (error) {
                if (error.status === 422) {
                    return res.json({
                        success: true,
                        data: {
                            detectedFaces: 0,
                            detectedPersons: 0,
                            trackedFaces: [],
                            antiSpoofing: {
                                isLive: false,
                                score: 0,
                            },
                        },
                    });
                }

                return res.json({
                    success: true,
                    data: {
                        detectedFaces: 0,
                        detectedPersons: 0,
                        trackedFaces: [],
                        aiUnavailable: true,
                        aiMessage: 'Face AI service unavailable for extraction',
                    },
                });
            }
        } catch (err) {
            next(err);
        }
    }
);

router.post(
    '/face-match',
    authenticate,
    requireRole('SECURITY_GUARD', 'HOD', 'SUPER_ADMIN', 'FACULTY', 'WARDEN'),
    validate(faceMatchSchema),
    async (req, res, next) => {
        try {
            const { faceDescriptor, imageFrame, streamId } = req.body;

            const normalizeBbox = (bbox) => {
                if (!Array.isArray(bbox) || bbox.length < 4) return null;
                const [x1, y1, x2, y2] = bbox;
                const normalized = [Number(x1), Number(y1), Number(x2), Number(y2)];
                if (normalized.some((value) => Number.isNaN(value))) return null;
                return normalized;
            };

            let descriptorItems = Array.isArray(faceDescriptor)
                ? [{ descriptor: faceDescriptor.slice(0, 128), trackId: null }]
                : [];
            let detectedFaces = descriptorItems.length;
            let detectedPersons = descriptorItems.length;
            let trackedFaceItems = descriptorItems.map((item) => ({
                trackId: item.trackId,
                descriptor: item.descriptor,
                bbox: null,
                isLive: true,
                antiSpoofScore: 0,
                detScore: 0,
            }));

            if (imageFrame) {
                try {
                    const extraction = await faceAiService.extractDescriptor(imageFrame, streamId || 'default');
                    if (extraction?.isLive === false) {
                        return res.json({
                            success: true,
                            data: {
                                matches: [],
                                detectedFaces: Number(extraction?.faceCount || 0),
                                detectedPersons: Number(extraction?.faceCount || 0),
                                trackedFaces: [],
                                antiSpoofing: {
                                    isLive: false,
                                    score: Number(extraction?.antiSpoofScore || 0),
                                },
                            },
                        });
                    }

                    if (Array.isArray(extraction?.trackedFaces) && extraction.trackedFaces.length > 0) {
                        const liveTrackedFaces = extraction.trackedFaces.filter((face) =>
                            Array.isArray(face?.descriptor) && face.descriptor.length >= 128 && face.isLive
                        );

                        const allTrackedFaces = extraction.trackedFaces.filter((face) =>
                            Array.isArray(face?.descriptor) && face.descriptor.length >= 128
                        );

                        const chosenFaces = liveTrackedFaces.length > 0 ? liveTrackedFaces : allTrackedFaces;

                        descriptorItems = chosenFaces.map((face) => ({
                            descriptor: face.descriptor,
                            trackId: face.trackId ?? null,
                        }));

                        trackedFaceItems = chosenFaces.map((face) => ({
                            trackId: face.trackId ?? null,
                            descriptor: face.descriptor,
                            bbox: normalizeBbox(face.bbox),
                            isLive: face.isLive !== false,
                            antiSpoofScore: Number(face.antiSpoofScore || 0),
                            detScore: Number(face.detScore || 0),
                        }));

                        detectedFaces = Number(extraction?.faceCount || chosenFaces.length);
                        detectedPersons = Number(extraction?.faceCount || chosenFaces.length);
                    } else if (Array.isArray(extraction?.descriptors) && extraction.descriptors.length > 0) {
                        const descriptors = extraction.descriptors
                            .filter((item) => Array.isArray(item) && item.length >= 128)
                            .map((item) => item);

                        const liveIndexes = Array.isArray(extraction?.liveDescriptorIndexes)
                            ? extraction.liveDescriptorIndexes
                            : [];

                        const liveDescriptors = liveIndexes
                            .map((index) => descriptors[index])
                            .filter(Boolean);

                        const chosenDescriptors = liveDescriptors.length > 0 ? liveDescriptors : descriptors;
                        descriptorItems = chosenDescriptors.map((descriptor) => ({ descriptor, trackId: null }));
                        trackedFaceItems = chosenDescriptors.map((descriptor) => ({
                            trackId: null,
                            descriptor,
                            bbox: null,
                            isLive: true,
                            antiSpoofScore: 0,
                            detScore: 0,
                        }));
                        detectedFaces = Number(extraction?.faceCount || chosenDescriptors.length);
                        detectedPersons = Number(extraction?.faceCount || chosenDescriptors.length);
                    } else if (Array.isArray(extraction?.descriptor) && extraction.descriptor.length >= 128) {
                        descriptorItems = [{ descriptor: extraction.descriptor, trackId: null }];
                        trackedFaceItems = [{
                            trackId: null,
                            descriptor: extraction.descriptor,
                            bbox: null,
                            isLive: extraction.isLive !== false,
                            antiSpoofScore: Number(extraction?.antiSpoofScore || 0),
                            detScore: 0,
                        }];
                        detectedFaces = Number(extraction?.faceCount || 1);
                        detectedPersons = Number(extraction?.faceCount || 1);
                    }
                } catch (error) {
                    if (descriptorItems.length === 0 && error.status === 422) {
                        return res.json({ success: true, data: { matches: [], detectedFaces: 0, detectedPersons: 0, trackedFaces: [] } });
                    }

                    if (descriptorItems.length === 0) {
                        return res.json({
                            success: true,
                            data: {
                                matches: [],
                                detectedFaces: 0,
                                detectedPersons: 0,
                                trackedFaces: [],
                                aiUnavailable: true,
                                aiMessage: 'Face AI service unavailable for real-time matching',
                            },
                        });
                    }
                }
            }

            const queryDescriptors = descriptorItems.map((item) => item.descriptor);

            if (!queryDescriptors.length) {
                return res.json({
                    success: true,
                    data: {
                        matches: [],
                        detectedFaces,
                        detectedPersons,
                        trackedFaces: trackedFaceItems.map((face, index) => ({
                            index,
                            trackId: face.trackId,
                            bbox: face.bbox,
                            isLive: face.isLive,
                            antiSpoofScore: face.antiSpoofScore,
                            detScore: face.detScore,
                        })),
                    },
                });
            }

            if (queryDescriptors.some((descriptor) => descriptor.length < 128)) {
                throw new AppError('Face descriptor is invalid', 400);
            }

            const normalizeVector = (vector) => {
                const arr = (Array.isArray(vector) ? vector : []).map((value) => Number(value));
                if (arr.length < 128 || arr.some((value) => Number.isNaN(value))) return [];
                const magnitude = Math.sqrt(arr.reduce((sum, value) => sum + (value * value), 0));
                if (magnitude <= 1e-8) return arr;
                return arr.map((value) => value / magnitude);
            };

            const alignVectorDimension = (vector, targetLength) => {
                if (!Array.isArray(vector) || targetLength < 1) return [];
                const source = vector.map((value) => Number(value));
                if (source.some((value) => Number.isNaN(value))) return [];
                if (source.length === targetLength) return source;
                if (source.length < 2) return [];

                const aligned = [];
                for (let i = 0; i < targetLength; i++) {
                    const mappedIndex = (i * (source.length - 1)) / Math.max(1, targetLength - 1);
                    const left = Math.floor(mappedIndex);
                    const right = Math.min(source.length - 1, left + 1);
                    const ratio = mappedIndex - left;
                    aligned.push((source[left] * (1 - ratio)) + (source[right] * ratio));
                }
                return aligned;
            };

            const cosineSimilarity = (left, right) => {
                const length = Math.min(left.length, right.length);
                if (length < 128) return -1;
                let dot = 0;
                for (let i = 0; i < length; i++) {
                    dot += left[i] * right[i];
                }
                return Math.max(-1, Math.min(1, dot));
            };

            const splitStoredEmbeddings = (flatEmbeddings, preferredDim) => {
                const values = Array.isArray(flatEmbeddings) ? flatEmbeddings.map((value) => Number(value)) : [];
                if (values.length < 128 || values.some((value) => Number.isNaN(value))) return [];

                const dimensionCandidates = [...new Set([
                    preferredDim,
                    512,
                    384,
                    256,
                    192,
                    128,
                ].filter((dimension) => Number.isInteger(dimension) && dimension >= 128))];

                let chosenDimension = null;
                for (const dimension of dimensionCandidates) {
                    if (values.length % dimension !== 0) continue;
                    const vectorCount = values.length / dimension;
                    if (vectorCount < 1 || vectorCount > 10) continue;
                    chosenDimension = dimension;
                    break;
                }

                if (!chosenDimension) {
                    chosenDimension = values.length >= preferredDim ? preferredDim : 128;
                    if (chosenDimension < 128 || values.length < chosenDimension) return [];
                }

                const vectors = [];
                const vectorCount = Math.max(1, Math.floor(values.length / chosenDimension));
                for (let index = 0; index < vectorCount; index++) {
                    const start = index * chosenDimension;
                    const vector = values.slice(start, start + chosenDimension);
                    if (vector.length === chosenDimension) vectors.push(vector);
                }
                return vectors;
            };

            const confidenceFromCosine = (similarity) => {
                const normalized = (Math.max(-1, Math.min(1, similarity)) + 1) / 2;
                const calibrated = Math.max(0, Math.min(1, (normalized - 0.58) / 0.40));
                return Math.round(calibrated * 100);
            };

            // Fetch all enrolled face data
            const enrolledFaces = await prisma.faceData.findMany({
                where: { isActive: true },
                select: {
                    studentId: true,
                    faceEmbeddings: true,
                    student: {
                        select: {
                            id: true,
                            fullName: true,
                            enrollmentNo: true,
                            studentType: true,
                        },
                    },
                },
            });

            if (enrolledFaces.length === 0) {
                return res.json({
                    success: true,
                    data: {
                        matches: [],
                        detectedFaces,
                        detectedPersons,
                        trackedFaces: trackedFaceItems.map((face, index) => ({
                            index,
                            trackId: face.trackId,
                            bbox: face.bbox,
                            isLive: face.isLive,
                            antiSpoofScore: face.antiSpoofScore,
                            detScore: face.detScore,
                        })),
                    },
                });
            }

            const normalizedQueryDescriptors = queryDescriptors.map((descriptor) => normalizeVector(descriptor));
            const queryDimension = normalizedQueryDescriptors[0]?.length || 128;

            const studentTemplates = enrolledFaces
                .map((faceRecord) => {
                    const vectors = splitStoredEmbeddings(faceRecord.faceEmbeddings || [], queryDimension)
                        .map((vector) => normalizeVector(alignVectorDimension(vector, queryDimension)))
                        .filter((vector) => vector.length === queryDimension);

                    return {
                        student: faceRecord.student,
                        vectors,
                    };
                })
                .filter((record) => record.vectors.length > 0);

            const matches = [];
            for (let faceIndex = 0; faceIndex < normalizedQueryDescriptors.length; faceIndex++) {
                const queryVector = normalizedQueryDescriptors[faceIndex];
                if (!queryVector.length) continue;

                let bestCandidate = null;
                let secondCandidate = null;

                studentTemplates.forEach((template) => {
                    let bestSimilarityForStudent = -1;
                    template.vectors.forEach((storedVector) => {
                        const similarity = cosineSimilarity(queryVector, storedVector);
                        if (similarity > bestSimilarityForStudent) {
                            bestSimilarityForStudent = similarity;
                        }
                    });

                    if (bestSimilarityForStudent < 0) return;
                    const candidate = {
                        studentId: template.student.id,
                        studentName: template.student.fullName,
                        enrollmentNo: template.student.enrollmentNo,
                        studentType: template.student.studentType,
                        similarity: bestSimilarityForStudent,
                    };

                    if (!bestCandidate || candidate.similarity > bestCandidate.similarity) {
                        secondCandidate = bestCandidate;
                        bestCandidate = candidate;
                    } else if (!secondCandidate || candidate.similarity > secondCandidate.similarity) {
                        secondCandidate = candidate;
                    }
                });

                if (!bestCandidate) continue;

                const similarityMargin = bestCandidate.similarity - (secondCandidate?.similarity || -1);
                const confidence = confidenceFromCosine(bestCandidate.similarity);
                const accepted = bestCandidate.similarity >= 0.35 && similarityMargin >= 0.035 && confidence >= 72;
                if (!accepted) continue;

                const distance = Math.sqrt(Math.max(0, 2 - (2 * bestCandidate.similarity)));
                matches.push({
                    studentId: bestCandidate.studentId,
                    studentName: bestCandidate.studentName,
                    enrollmentNo: bestCandidate.enrollmentNo,
                    studentType: bestCandidate.studentType,
                    confidence,
                    distance: Math.round(distance * 1000) / 1000,
                    cosineSimilarity: Math.round(bestCandidate.similarity * 1000) / 1000,
                    similarityMargin: Math.round(similarityMargin * 1000) / 1000,
                    matchedFaceIndex: faceIndex,
                    trackId: descriptorItems[faceIndex]?.trackId ?? null,
                    bbox: trackedFaceItems[faceIndex]?.bbox || null,
                    isLive: trackedFaceItems[faceIndex]?.isLive !== false,
                    antiSpoofScore: Number(trackedFaceItems[faceIndex]?.antiSpoofScore || 0),
                    detScore: Number(trackedFaceItems[faceIndex]?.detScore || 0),
                });
            }

            matches.sort((a, b) => b.confidence - a.confidence);
            const limitedMatches = matches.slice(0, 5);

            const bestMatchByFaceIndex = new Map();
            limitedMatches.forEach((match) => {
                const previous = bestMatchByFaceIndex.get(match.matchedFaceIndex);
                if (!previous || match.confidence > previous.confidence) {
                    bestMatchByFaceIndex.set(match.matchedFaceIndex, match);
                }
            });

            const trackedFaces = trackedFaceItems.map((face, index) => {
                const linkedMatch = bestMatchByFaceIndex.get(index);
                return {
                    index,
                    trackId: face.trackId,
                    bbox: face.bbox,
                    isLive: face.isLive,
                    antiSpoofScore: face.antiSpoofScore,
                    detScore: face.detScore,
                    studentId: linkedMatch?.studentId || null,
                    studentName: linkedMatch?.studentName || null,
                    enrollmentNo: linkedMatch?.enrollmentNo || null,
                    studentType: linkedMatch?.studentType || null,
                    confidence: Number(linkedMatch?.confidence || 0),
                };
            });

            // Log match attempt was made
            if (limitedMatches.length > 0 && limitedMatches[0].confidence > 85) {
                await prisma.faceData.update({
                    where: { studentId: limitedMatches[0].studentId },
                    data: {
                        lastMatchedAt: new Date(),
                        matchCount: { increment: 1 },
                    },
                }).catch(() => { });
            }

            res.json({ success: true, data: { matches: limitedMatches, detectedFaces, detectedPersons, trackedFaces } });
        } catch (err) {
            next(err);
        }
    }
);

// ── POST /face-detection — Log entry/exit based on face detection ──
const faceDetectionSchema = z.object({
    studentId: z.string(),
    direction: z.enum(['ENTRY', 'EXIT']),
    confidence: z.number().min(0).max(100),
    timestamp: z.string().datetime().optional(),
    source: z.string().optional(),
});

const FACE_DETECTION_DUPLICATE_WINDOW_MS = 20000;

router.post(
    '/face-detection',
    authenticate,
    requireRole('SECURITY_GUARD', 'HOD', 'SUPER_ADMIN', 'WARDEN'),
    validate(faceDetectionSchema),
    async (req, res, next) => {
        try {
            const { studentId, direction, confidence, timestamp, source } = req.body;
            const logTimestamp = timestamp ? new Date(timestamp) : new Date();

            if (!MONGODB_OBJECT_ID_REGEX.test(studentId)) {
                throw new AppError('Invalid studentId format', 400);
            }

            const student = await prisma.student.findUnique({
                where: { id: studentId },
                select: { id: true, studentType: true },
            });

            if (!student) {
                throw new AppError('Student not found', 404);
            }

            if (!['HOSTELLER_BOYS', 'HOSTELLER_GIRLS'].includes(student.studentType)) {
                throw new AppError('Hosteller log channel only supports hostellers', 400);
            }

            const duplicateWindowStart = new Date(logTimestamp.getTime() - FACE_DETECTION_DUPLICATE_WINDOW_MS);
            const recentDuplicate = await prisma.faceDetectionLog.findFirst({
                where: {
                    studentId,
                    direction,
                    timestamp: {
                        gte: duplicateWindowStart,
                    },
                },
                orderBy: {
                    timestamp: 'desc',
                },
            });

            if (recentDuplicate) {
                return res.json({
                    success: true,
                    data: {
                        log: recentDuplicate,
                        duplicate: true,
                        message: `${direction} already logged a few seconds ago`,
                    },
                });
            }

            // Create face detection log
            const log = await prisma.faceDetectionLog.create({
                data: {
                    studentId,
                    direction,
                    confidence: Math.round(confidence),
                    timestamp: logTimestamp,
                    source: source || 'Hosteller Face Gate',
                },
            });

            res.json({
                success: true,
                data: {
                    log,
                    message: `${direction} logged via face detection with ${Math.round(confidence)}% confidence`,
                },
            });
        } catch (err) {
            next(err);
        }
    }
);

module.exports = router;
