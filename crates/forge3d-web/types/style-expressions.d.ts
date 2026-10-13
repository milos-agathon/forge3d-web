export interface StyleEvalContext {
    properties?: Record<string, unknown>;
    zoom?: number;
    geometryType?: string;
}
export declare const STYLE_EXPRESSION_OPERATORS: Set<string>;
/** The native Python evaluator's supported behavior, including arity and Python coercions. */
export declare function evaluateStyleExpression(expression: unknown, context?: StyleEvalContext): unknown;
/** Native legacy filters pass unknown operators through; validation still diagnoses them. */
export declare function evaluateStyleFilter(filter: unknown, context?: StyleEvalContext, depth?: number): boolean;
