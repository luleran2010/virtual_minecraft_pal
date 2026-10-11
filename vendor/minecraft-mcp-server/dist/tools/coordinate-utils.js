export function coerceCoordinates(x, y, z) {
    const coercedX = Number(x);
    const coercedY = Number(y);
    const coercedZ = Number(z);
    if (!Number.isFinite(coercedX) || !Number.isFinite(coercedY) || !Number.isFinite(coercedZ)) {
        throw new Error("x, y, and z must be valid numbers");
    }
    return { x: coercedX, y: coercedY, z: coercedZ };
}
