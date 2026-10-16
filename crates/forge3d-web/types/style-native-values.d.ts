/** Preserve Python numeric result kinds inside evaluation; public results remain JS values. */
export declare class NativeNumber {
    readonly value: number;
    readonly floating: boolean;
    constructor(value: number, floating: boolean);
}
export declare class NativeTuple {
    readonly values: unknown[];
    constructor(values: unknown[]);
}
export declare function scalar(v: unknown): unknown;
export declare function numeric(v: unknown): boolean;
export declare function number(v: unknown): number;
export declare function floating(v: unknown): boolean;
export declare function result(value: number, float?: boolean): unknown;
export declare function unwrap(v: unknown): unknown;
export declare function nativeTruth(v: unknown): boolean;
export declare function nativeEqual(a: unknown, b: unknown): boolean;
export declare function nativeString(v: unknown, repr?: boolean): string;
export declare function nativeFloat(value: unknown): unknown;
