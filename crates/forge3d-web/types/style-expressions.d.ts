export interface StyleEvalContext {
    properties?: Record<string, unknown>;
    zoom?: number;
    geometryType?: string;
}
export declare const STYLE_EXPRESSION_OPERATORS: Set<string>;
/** Native expression subset. Failure returns null; unknown operators are diagnosed by the style parser. */
export declare function evaluateStyleExpression(expression: unknown, context?: StyleEvalContext): unknown;
/** Legacy property filters are separate from expression literals. Native maxzoom is inclusive. */
export declare function evaluateStyleFilter(filter: unknown, context?: StyleEvalContext): boolean;
