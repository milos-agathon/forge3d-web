import { Forge3DError } from "./index.js";
import type { CrsMetadata, CrsAxis } from "./crs-types.js";

export interface ProjModule {
  FS: {
    mkdirTree(path: string): void;
    writeFile(path: string, bytes: Uint8Array): void;
    chdir(path: string): void;
  };
  HEAPF64: Float64Array;
  HEAPU8: Uint8Array;
  _malloc(bytes: number): number;
  _free(ptr: number): void;
  getValue(ptr: number, type: string): number;
  setValue(ptr: number, value: number, type: string): void;
  UTF8ToString(ptr: number): string;
  stringToUTF8(value: string, ptr: number, length: number): void;
  lengthBytesUTF8(value: string): number;
  ccall(
    name: string,
    returnType: string | null,
    types: string[],
    values: (string | number)[],
  ): unknown;
}
export class ProjKernel {
  constructor(
    readonly module: ProjModule,
    database: Uint8Array,
    grids: Readonly<Record<string, Uint8Array>>,
  ) {
    module.FS.mkdirTree("/proj");
    module.FS.writeFile("/proj/proj.db", database);
    for (const [name, bytes] of Object.entries(grids))
      module.FS.writeFile("/proj/" + name, bytes);
    module.FS.chdir("/proj");
  }
  private call(
    name: string,
    result: string | null,
    ...values: (string | number)[]
  ): unknown {
    try {
      return this.module.ccall(
        name,
        result,
        values.map((x) => (typeof x === "string" ? "string" : "number")),
        values,
      );
    } catch (error) {
      throw new Forge3DError(
        /out of memory|allocation failed/i.test(String(error))
          ? "OUT_OF_MEMORY"
          : "INVALID_INPUT",
        String(error instanceof Error ? error.message : error),
        { kind: "crs-transform", stage: name, reason: String(error) },
      );
    }
  }
  private number(name: string, ...values: (string | number)[]): number {
    return Number(this.call(name, "number", ...values));
  }
  private text(name: string, ...values: (string | number)[]): string {
    return String(this.call(name, "string", ...values) ?? "");
  }
  private context(): number {
    const ctx = this.number("proj_context_create");
    if (!ctx)
      throw new Forge3DError("OUT_OF_MEMORY", "PROJ context allocation failed");
    this.number("proj_context_set_enable_network", ctx, 0);
    this.number("proj_log_level", ctx, 0);
    if (
      !this.number("proj_context_set_database_path", ctx, "/proj/proj.db", 0, 0)
    ) {
      this.call("proj_context_destroy", null, ctx);
      throw new Forge3DError(
        "WASM_LOAD_FAILED",
        "PROJ database initialization failed",
      );
    }
    return ctx;
  }
  private definition(value: string): string {
    if (
      typeof value !== "string" ||
      !value.trim() ||
      value.length > 65536 ||
      value.includes("\0")
    )
      throw new Forge3DError(
        "INVALID_INPUT",
        "CRS must be a nonempty definition of at most 65536 characters",
      );
    if (/(?:^|\s)\+?proj=(?:pipeline|noop)(?:\s|$)/u.test(value))
      throw new Forge3DError(
        "INVALID_INPUT",
        "Coordinate operations are not CRS definitions",
      );
    if (
      /(?:\+?(?:grids|nadgrids|geoidgrids))=(?:[^\s]*@|null(?:\s|$))/u.test(
        value,
      )
    )
      throw new Forge3DError(
        "INVALID_INPUT",
        "Optional or null grids cannot guarantee a precise CRS transform",
      );
    return /^\s*\+?proj=/u.test(value) &&
      !/(?:^|\s)\+?type=crs(?:\s|$)/u.test(value)
      ? value + " +type=crs"
      : value;
  }
  private fail(ctx: number, stage: string, src = 0, dst = 0): never {
    const errno = this.number("proj_context_errno", ctx);
    const reason = this.text("proj_context_errno_string", ctx, errno);
    const grids =
      src && dst && (errno === 2051 || stage === "operation")
        ? this.unavailableGrids(ctx, src, dst)
        : [];
    const missing =
      grids.length > 0 ||
      errno === 1029 ||
      errno === 2052 ||
      /grid|file not found|best transformation/i.test(reason);
    throw new Forge3DError(
      missing ? "UNSUPPORTED_FEATURE" : "INVALID_INPUT",
      `PROJ ${stage} failed: ${reason || "no valid operation"}`,
      {
        kind: missing ? "crs-missing-grid" : "crs-transform",
        stage,
        projErrno: errno,
        reason,
        grids,
        networkEnabled: false,
      },
    );
  }
  private unavailableGrids(ctx: number, src: number, dst: number): string[] {
    const factory = this.number(
        "proj_create_operation_factory_context",
        ctx,
        0,
      ),
      names = new Set<string>();
    let list = 0;
    try {
      // PROJ_GRID_AVAILABILITY_IGNORED = 2: enumerate also unavailable operations.
      this.call(
        "proj_operation_factory_context_set_grid_availability_use",
        null,
        ctx,
        factory,
        2,
      );
      this.call(
        "proj_operation_factory_context_set_crs_extent_use",
        null,
        ctx,
        factory,
        0,
      );
      this.call(
        "proj_operation_factory_context_set_spatial_criterion",
        null,
        ctx,
        factory,
        1,
      );
      this.call(
        "proj_operation_factory_context_set_use_proj_alternative_grid_names",
        null,
        ctx,
        factory,
        1,
      );
      list = this.number("proj_create_operations", ctx, src, dst, factory);
      for (let i = 0; i < this.number("proj_list_get_count", list); i++) {
        const operation = this.number("proj_list_get", ctx, list, i),
          out = this.module._malloc(28);
        try {
          for (
            let g = 0;
            g <
            this.number(
              "proj_coordoperation_get_grid_used_count",
              ctx,
              operation,
            );
            g++
          ) {
            this.module.HEAPU8.fill(0, out, out + 28);
            if (
              this.number(
                "proj_coordoperation_get_grid_used",
                ctx,
                operation,
                g,
                out,
                out + 4,
                out + 8,
                out + 12,
                out + 16,
                out + 20,
                out + 24,
              ) &&
              !this.module.getValue(out + 24, "i32")
            )
              names.add(
                this.module.UTF8ToString(this.module.getValue(out, "i32")),
              );
          }
        } finally {
          this.module._free(out);
          this.call("proj_destroy", null, operation);
        }
      }
      return [...names];
    } finally {
      if (list) this.call("proj_list_destroy", null, list);
      this.call("proj_operation_factory_context_destroy", null, factory);
    }
  }
  metadata(definition: string): CrsMetadata {
    const ctx = this.context();
    let pj = 0,
      cs = 0,
      list = 0,
      conf = 0,
      identified = 0;
    try {
      pj = this.number("proj_create", ctx, this.definition(definition));
      if (!pj || !this.number("proj_is_crs", pj)) this.fail(ctx, "parse");
      let authority = this.text("proj_get_id_auth_name", pj, 0) || null,
        code = this.text("proj_get_id_code", pj, 0) || null;
      if (authority === null) {
        conf = this.module._malloc(4);
        this.module.setValue(conf, 0, "i32");
        list = this.number("proj_identify", ctx, pj, "EPSG", 0, conf);
        const confidence = this.module.getValue(conf, "i32");
        if (
          list &&
          this.number("proj_list_get_count", list) > 0 &&
          confidence &&
          this.module.getValue(confidence, "i32") >= 70
        ) {
          identified = this.number("proj_list_get", ctx, list, 0);
          authority = this.text("proj_get_id_auth_name", identified, 0) || null;
          code = this.text("proj_get_id_code", identified, 0) || null;
        }
        if (confidence) this.call("proj_int_list_destroy", null, confidence);
      }
      cs = this.number("proj_crs_get_coordinate_system", ctx, pj);
      const axes: CrsAxis[] = [];
      if (cs)
        for (
          let i = 0;
          i < this.number("proj_cs_get_axis_count", ctx, cs);
          i++
        ) {
          const ptr = this.module._malloc(40);
          try {
            this.module.HEAPU8.fill(0, ptr, ptr + 40);
            if (
              this.number(
                "proj_cs_get_axis_info",
                ctx,
                cs,
                i,
                ptr,
                ptr + 4,
                ptr + 8,
                ptr + 16,
                ptr + 24,
                ptr + 28,
                ptr + 32,
              )
            ) {
              const text = (offset: number) =>
                this.module.UTF8ToString(
                  this.module.getValue(ptr + offset, "i32"),
                );
              axes.push({
                name: text(0),
                abbreviation: text(4),
                direction: text(8),
                unitConversionFactor: this.module.getValue(ptr + 16, "double"),
                unitName: text(24),
              });
            }
          } finally {
            this.module._free(ptr);
          }
        }
      return {
        definition,
        name: this.text("proj_get_name", pj),
        authority,
        code,
        epsg: authority === "EPSG" && code !== null ? Number(code) : null,
        type: this.number("proj_get_type", pj),
        wkt: this.text("proj_as_wkt", ctx, pj, 2, 0),
        axes,
      };
    } finally {
      if (cs) this.call("proj_destroy", null, cs);
      if (identified) this.call("proj_destroy", null, identified);
      if (list) this.call("proj_list_destroy", null, list);
      if (conf) this.module._free(conf);
      if (pj) this.call("proj_destroy", null, pj);
      this.call("proj_context_destroy", null, ctx);
    }
  }
  transform(
    coords: Float64Array,
    source: string,
    target: string,
    alwaysXY: boolean,
    stride: number,
    pipeline?: string,
  ): Float64Array {
    const m = this.module,
      ctx = this.context();
    let src = 0,
      dst = 0,
      pj = 0,
      normalized = 0,
      ptr = 0,
      options = 0;
    const strings: number[] = [];
    try {
      if (pipeline !== undefined) {
        pj = this.number("proj_create", ctx, pipeline);
      } else {
        src = this.number("proj_create", ctx, this.definition(source));
        dst = this.number("proj_create", ctx, this.definition(target));
        if (
          !src ||
          !dst ||
          !this.number("proj_is_crs", src) ||
          !this.number("proj_is_crs", dst)
        )
          this.fail(ctx, "parse");
        options = m._malloc(12);
        for (const [i, value] of [
          "ONLY_BEST=YES",
          "ALLOW_BALLPARK=NO",
        ].entries()) {
          const len = m.lengthBytesUTF8(value) + 1,
            p = m._malloc(len);
          strings.push(p);
          m.stringToUTF8(value, p, len);
          m.setValue(options + i * 4, p, "i32");
        }
        m.setValue(options + 8, 0, "i32");
        pj = this.number(
          "proj_create_crs_to_crs_from_pj",
          ctx,
          src,
          dst,
          0,
          options,
        );
        if (pj && alwaysXY) {
          normalized = this.number("proj_normalize_for_visualization", ctx, pj);
          if (!normalized) this.fail(ctx, "axis-normalization");
        }
      }
      if (!pj) this.fail(ctx, "operation", src, dst);
      const count = coords.length / stride,
        result = new Float64Array(coords.length);
      if (count === 0) return result;
      ptr = m._malloc(count * 32);
      if (!ptr)
        throw new Forge3DError(
          "OUT_OF_MEMORY",
          "PROJ coordinate allocation failed",
        );
      for (let i = 0; i < count; i++) {
        for (let j = 0; j < 4; j++)
          m.HEAPF64[ptr / 8 + i * 4 + j] =
            j < stride ? coords[i * stride + j]! : j === 3 ? Infinity : 0;
      }
      const error = this.number(
        "proj_trans_array",
        normalized || pj,
        1,
        count,
        ptr,
      );
      if (error) this.fail(ctx, "coordinates", src, dst);
      for (let i = 0; i < count; i++)
        for (let j = 0; j < stride; j++) {
          const value = m.HEAPF64[ptr / 8 + i * 4 + j]!;
          if (!Number.isFinite(value)) this.fail(ctx, "coordinates", src, dst);
          result[i * stride + j] = value;
        }
      return result;
    } finally {
      if (ptr) m._free(ptr);
      if (normalized) this.call("proj_destroy", null, normalized);
      if (pj) this.call("proj_destroy", null, pj);
      if (src) this.call("proj_destroy", null, src);
      if (dst) this.call("proj_destroy", null, dst);
      for (const p of strings) m._free(p);
      if (options) m._free(options);
      this.call("proj_context_destroy", null, ctx);
    }
  }
}
