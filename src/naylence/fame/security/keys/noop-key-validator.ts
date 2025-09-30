import { getLogger } from "../../util/logging.js";

import {
  AttachmentKeyValidator,
  KeyInfo,
  type AttachmentKey,
  type AttachmentKeyValidationResult,
} from "./attachment-key-validator.js";

const logger = getLogger("noop-key-validator");

export class NoopKeyValidator extends AttachmentKeyValidator {
  constructor() {
    super();
    logger.debug("noop_key_validator_initialized");
  }

  public async validateKey(_key: AttachmentKey): Promise<KeyInfo> {
    return new KeyInfo();
  }

  public async validateChildAttachmentLogicals(
    _childKeys: readonly AttachmentKey[] | null | undefined,
    _authorizedLogicals: readonly string[] | null | undefined,
    _childId: string
  ): Promise<AttachmentKeyValidationResult> {
    return [true, "Noop validator always authorizes logicals"] as const;
  }
}
