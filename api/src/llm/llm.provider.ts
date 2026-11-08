/**
 * The rest of the app only knows this contract. To use Claude or another model
 * later, write one new class that extends it. Nothing else changes.
 */
export abstract class LlmProvider {
  abstract readonly modelName: string;
  /** Send a system + user prompt, get back a string that should be JSON. */
  abstract completeJson(system: string, user: string): Promise<string>;
}
