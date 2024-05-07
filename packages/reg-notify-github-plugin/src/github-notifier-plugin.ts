import { inflateRawSync } from "zlib";
import { getGhAppInfo, BaseEventBody, UpdateStatusBody } from "reg-gh-app-interface";
import { NotifierPlugin, NotifyParams, PluginCreateOptions, PluginLogger } from "reg-suit-interface";
import { fetch } from "undici";

type PrCommentBehavior = "default" | "once" | "new";

type FetchRequest = {
  url: string;
  method: "GET" | "POST" | "PUT" | "DELETE";
  body: BaseEventBody;
};

export interface GitHubPluginOption {
  clientId?: string;
  installationId?: string;
  owner?: string;
  repository?: string;
  prComment?: boolean;
  prCommentBehavior?: PrCommentBehavior;
  setCommitStatus?: boolean;
  customEndpoint?: string;
  shortDescription?: boolean;
}

interface GhAppStatusCodeError {
  name: "StatusCodeError";
  statusCode: number;
  error: {
    message: string;
  };
}

function isGhAppError(x: any): x is GhAppStatusCodeError {
  return x.name && x.name === "StatusCodeError";
}

const errorHandler = (logger: PluginLogger) => {
  return (reason: any) => {
    if (isGhAppError(reason)) {
      logger.error(reason.error.message);
      return Promise.reject(reason.error);
    } else {
      return Promise.reject(reason);
    }
  };
};

export class GitHubNotifierPlugin implements NotifierPlugin<GitHubPluginOption> {
  _logger!: PluginLogger;
  _noEmit!: boolean;
  _apiOpt!: BaseEventBody;
  _prComment!: boolean;
  _setCommitStatus!: boolean;
  _behavior!: PrCommentBehavior;
  _shortDescription!: boolean;

  _apiPrefix!: string;

  _decodeClientId(clientId: string) {
    const tmp = inflateRawSync(new Buffer(clientId, "base64")).toString().split("/");
    if (tmp.length !== 4) {
      this._logger.error(`Invalid client ID: ${this._logger.colors.red(clientId)}`);
      throw new Error(`Invalid client ID: ${clientId}`);
    }
    const [repository, installationId, owner] = tmp.slice(1);
    return { repository, installationId, owner };
  }

  init(config: PluginCreateOptions<GitHubPluginOption>) {
    this._noEmit = config.noEmit;
    this._logger = config.logger;
    if (config.options.clientId) {
      this._apiOpt = this._decodeClientId(config.options.clientId);
    } else {
      this._apiOpt = config.options as BaseEventBody;
    }
    this._prComment = config.options.prComment !== false;
    this._behavior = config.options.prCommentBehavior ?? "default";
    this._setCommitStatus = config.options.setCommitStatus !== false;
    this._shortDescription = config.options.shortDescription ?? false;
    this._apiPrefix = config.options.customEndpoint || getGhAppInfo().endpoint;
  }

  async notify(params: NotifyParams): Promise<any> {
    const {
      // passedItems,
      failedItems,
      newItems,
      deletedItems,
    } = params.comparisonResult;
    const failedItemsCount = failedItems.length;
    const newItemsCount = newItems.length;
    const deletedItemsCount = deletedItems.length;
    // const passedItemsCount = passedItems.length;
    const state = failedItemsCount + newItemsCount + deletedItemsCount === 0 ? "success" : "failure";
    const description = state === "success" ? "Regression testing passed" : "Regression testing failed";

    // @ts-ignore
    const sha1: string = process.env.COMMIT_INFO_SHA;

    const updateStatusBody: UpdateStatusBody = {
      ...this._apiOpt,
      sha1,
      description,
      state,
    };
    if (params.reportUrl) updateStatusBody.reportUrl = params.reportUrl;

    const reqs: FetchRequest[] = [];

    if (this._setCommitStatus) {
      const statusReq: FetchRequest = {
        url: `${this._apiPrefix}/api/update-status`,
        method: "POST",
        body: updateStatusBody,
      };
      this._logger.info(`Update status for ${this._logger.colors.green(updateStatusBody.sha1)} .`);
      this._logger.verbose("update-status: ", statusReq);
      reqs.push(statusReq);
    }

    if (this._noEmit) {
      return Promise.resolve();
    }
    const spinner = this._logger.getSpinner("sending notification to GitHub...");
    spinner.start();
    return Promise.all(
      reqs.map(async req => {
        try {
          const res = await fetch(req.url, {
            method: req.method,
            body: JSON.stringify(req.body),
          });

          if (400 <= res.status) {
            throw new Error(`HTTP ${res.status}: Failed to request.`);
          }
        } catch (err) {
          const handler = errorHandler(this._logger);
          await handler(err);
        }
      }),
    )
      .then(() => spinner.stop())
      .catch(() => spinner.stop());
  }
}
