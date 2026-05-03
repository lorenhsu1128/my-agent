import {StandardErrorBody} from "./types.js";

export function makeError(
    code: string,
    message: string,
    type: string = "invalid_request_error",
    param: string | null = null
): StandardErrorBody {
    return {error: {code, message, type, param}};
}

export const NOT_IMPLEMENTED_501 = (endpoint: string, code: string) =>
    makeError(
        code,
        `Endpoint ${endpoint} is not supported by TCQ-shim. ` +
        `Use buun-llama-cpp llama-server for this functionality.`,
        "not_implemented"
    );
