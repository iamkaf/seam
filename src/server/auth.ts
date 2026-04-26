import type {
  CreateMutationDefinition,
  CreateSeamServerOptions,
  SeamAuthorizeInput,
} from "./types.js";

export async function authorize<TMutations extends Record<string, CreateMutationDefinition>>(
  options: CreateSeamServerOptions<TMutations>,
  input: SeamAuthorizeInput,
): Promise<boolean> {
  return options.authorize ? options.authorize(input) : true;
}
