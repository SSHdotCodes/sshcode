import { sessionBoxActivityModels } from "./activity.ts";
import { sessionBoxAttentionModels } from "./attention.ts";
import { sessionBoxLabelModels } from "./label.ts";
import { needsYouModel } from "./needsYou.ts";
import { commandWeights } from "./weights/command.ts";
import { keepWeights } from "./weights/keep.ts";
import { needsYouWeights } from "./weights/needsYou.ts";
import { replyWeights } from "./weights/reply.ts";
import { topicWeights } from "./weights/topic.ts";

sessionBoxLabelModels.topic = topicWeights;
sessionBoxLabelModels.keep = keepWeights;
sessionBoxActivityModels.command = commandWeights;
sessionBoxAttentionModels.reply = replyWeights;
needsYouModel.weights = needsYouWeights;
