import { toUtf8 } from "@cosmjs/encoding";
import {
  calculateFee,
  Coin,
  GasPrice,
  SigningStargateClient
} from "@cosmjs/stargate";
import axios, { AxiosInstance } from "axios";
import { MsgExecuteContract } from "cosmjs-types/cosmwasm/wasm/v1/tx";
import { BigNumber, ethers, UnsignedTransaction } from "ethers";

import {
  Allowance,
  Approve,
  ApproveRoute,
  ChainData,
  Config,
  CosmosMsg,
  ExecuteRoute,
  GetRoute,
  GetStatus,
  IBC_TRANSFER_TYPE,
  IsRouteApproved,
  RouteData,
  RouteParams,
  RouteParamsData,
  RouteResponse,
  StatusResponse,
  TokenData,
  TransactionRequest,
  ValidateBalanceAndApproval,
  WASM_TYPE,
  WasmHookMsg
} from "./types";

import { TxRaw } from "cosmjs-types/cosmos/tx/v1beta1/tx";
import { parseRouteResponse } from "./0xsquid/v1/route";
import { parseSdkInfoResponse } from "./0xsquid/v1/sdk-info";
import { parseStatusResponse } from "./0xsquid/v1/status";
import erc20Abi from "./abi/erc20.json";
import { nativeTokenConstant, uint256MaxValue } from "./constants";
import { ErrorType, SquidError } from "./error";
import { getChainData, getTokenData } from "./utils";
import { setAxiosInterceptors } from "./utils/setAxiosInterceptors";

const baseUrl = "https://testnet.api.0xsquid.com/";

export class Squid {
  private axiosInstance: AxiosInstance;

  public initialized = false;
  public config: Config;
  public tokens: TokenData[] = [] as TokenData[];
  public chains: ChainData[] = [] as ChainData[];
  public axelarscanURL: string | undefined;
  public isInMaintenanceMode = false;
  public maintenanceMessage: string | undefined;

  constructor(config = {} as Config) {
    this.axiosInstance = setAxiosInterceptors(
      axios.create({
        baseURL: config?.baseUrl || baseUrl,
        headers: {
          // 'api-key': config.apiKey
          "x-integrator-id": "squid-sdk"
        }
      }),
      config
    );

    this.config = {
      baseUrl: config?.baseUrl || baseUrl,
      ...config
    };
  }

  private validateInit() {
    if (!this.initialized) {
      throw new SquidError({
        message:
          "SquidSdk must be initialized! Please call the SquidSdk.init method",
        errorType: ErrorType.InitError,
        logging: this.config.logging,
        logLevel: this.config.logLevel
      });
    }
  }

  private async validateBalanceAndApproval({
    fromTokenContract,
    fromAmount,
    fromIsNative,
    targetAddress,
    fromProvider,
    fromChain,
    signer,
    infiniteApproval,
    overrides
  }: ValidateBalanceAndApproval) {
    const _sourceAmount = ethers.BigNumber.from(fromAmount);
    let address;

    if (signer && ethers.Signer.isSigner(signer)) {
      address = await (signer as ethers.Signer).getAddress();
    } else {
      address = (signer as ethers.Wallet).address;
    }

    if (!fromIsNative) {
      const balance = await fromTokenContract.balanceOf(address);

      if (_sourceAmount.gt(balance)) {
        throw new SquidError({
          message: `Insufficient funds for account: ${address} on chain ${fromChain.chainId}`,
          errorType: ErrorType.ValidationError,
          logging: this.config.logging,
          logLevel: this.config.logLevel
        });
      }

      const allowance = await fromTokenContract.allowance(
        address,
        targetAddress
      );

      if (_sourceAmount.gt(allowance)) {
        let amountToApprove: BigNumber = ethers.BigNumber.from(uint256MaxValue);

        if (infiniteApproval === false) {
          amountToApprove = _sourceAmount;
        }

        if (
          this.config?.executionSettings?.infiniteApproval === false &&
          !infiniteApproval
        ) {
          amountToApprove = ethers.BigNumber.from(uint256MaxValue);
        }

        const approveTx = await fromTokenContract
          .connect(signer)
          .approve(targetAddress, amountToApprove, overrides);
        await approveTx.wait();
      }
    } else {
      const balance = await fromProvider.getBalance(address);

      if (_sourceAmount.gt(balance)) {
        throw new SquidError({
          message: `Insufficient funds for account: ${address} on chain ${fromChain.chainId}`,
          errorType: ErrorType.ValidationError,
          logging: this.config.logging,
          logLevel: this.config.logLevel
        });
      }
    }
  }

  private validateRouteParams(params: RouteParams): RouteParamsData {
    const { fromChain, toChain, fromToken, toToken } = params;

    const _fromChain = getChainData(
      this.chains as ChainData[],
      params.fromChain
    );
    if (!_fromChain) {
      throw new SquidError({
        message: `fromChain not found for ${fromChain}`,
        errorType: ErrorType.ValidationError,
        logging: this.config.logging,
        logLevel: this.config.logLevel
      });
    }

    const _toChain = getChainData(this.chains as ChainData[], toChain);
    if (!_toChain) {
      throw new SquidError({
        message: `toChain not found for ${fromChain}`,
        errorType: ErrorType.ValidationError,
        logging: this.config.logging,
        logLevel: this.config.logLevel
      });
    }

    const fromProvider = new ethers.providers.JsonRpcProvider(_fromChain.rpc);

    const fromIsNative = fromToken.address === nativeTokenConstant;
    let fromTokenContract;

    if (!fromIsNative) {
      fromTokenContract = new ethers.Contract(
        fromToken.address,
        erc20Abi,
        fromProvider
      );
    }

    return {
      fromChain: _fromChain,
      toChain: _toChain,
      fromToken,
      toToken,
      fromTokenContract,
      fromProvider,
      fromIsNative
    };
  }

  private validateTransactionRequest(
    transactionRequest?: TransactionRequest
  ): TransactionRequest {
    if (!transactionRequest) {
      throw new SquidError({
        message: `transactionRequest param not found in route object`,
        errorType: ErrorType.ValidationError,
        logging: this.config.logging,
        logLevel: this.config.logLevel
      });
    }
    return transactionRequest;
  }

  private async validateCosmosBalance(
    signer: SigningStargateClient,
    signerAddress: string,
    coin: Coin
  ): Promise<void> {
    const signerCoinBalance = await signer.getBalance(
      signerAddress,
      coin.denom
    );

    const currentBalance = ethers.BigNumber.from(signerCoinBalance.amount);
    const transferAmount = ethers.BigNumber.from(coin.amount);

    if (transferAmount.gt(currentBalance)) {
      throw new SquidError({
        message: `transfer amount is greater then account balance`,
        errorType: ErrorType.ValidationError,
        logging: this.config.logging,
        logLevel: this.config.logLevel
      });
    }
  }

  public async init() {
    const response = await this.axiosInstance.get("/v1/sdk-info");
    if (response.status != 200) {
      throw new SquidError({
        message: `SDK initialization failed`,
        errorType: ErrorType.InitError,
        logging: this.config.logging,
        logLevel: this.config.logLevel
      });
    }
    const typeResponse = parseSdkInfoResponse(response.data);
    this.tokens = typeResponse.tokens;
    this.chains = typeResponse.chains;
    this.axelarscanURL = typeResponse.axelarscanURL;
    this.isInMaintenanceMode = typeResponse.isInMaintenanceMode;
    this.maintenanceMessage = typeResponse.maintenanceMessage;
    this.initialized = true;
  }

  public setConfig(config: Config) {
    this.axiosInstance = axios.create({
      baseURL: config.baseUrl || baseUrl,
      headers: {
        // 'api-key': config.apiKey
        ...(config.integratorId && { "x-integrator-id": config.integratorId })
      }
    });
    this.config = config;
  }

  public async getRoute(params: GetRoute): Promise<RouteResponse> {
    this.validateInit();
    const response = await this.axiosInstance.get("/v1/route", { params });
    if (response.status != 200) {
      response.data.error;
      throw new SquidError({
        message: response.data.error,
        errorType: ErrorType.RouteResponseError,
        logging: this.config.logging,
        logLevel: this.config.logLevel
      });
    }

    const route: RouteResponse = parseRouteResponse(
      response.data,
      response.headers
    );
    return route;
  }

  public async executeRoute({
    signer,
    signerAddress,
    route,
    executionSettings,
    overrides
  }: ExecuteRoute): Promise<ethers.providers.TransactionResponse | TxRaw> {
    this.validateInit();

    if (!route.transactionRequest) {
      throw new SquidError({
        message: `transactionRequest property is missing in route object`,
        errorType: ErrorType.ValidationError,
        logging: this.config.logging,
        logLevel: this.config.logLevel
      });
    }

    // handle cosmos case
    if (
      signer instanceof SigningStargateClient ||
      signer.constructor.name === "SigningStargateClient"
    ) {
      return await this.executeRouteCosmos(
        signer as SigningStargateClient,
        signerAddress!,
        route
      );
    }

    const { transactionRequest, params } = route;

    const { fromIsNative, fromChain, fromTokenContract, fromProvider } =
      this.validateRouteParams(route.params);

    const {
      targetAddress,
      maxFeePerGas,
      maxPriorityFeePerGas,
      gasPrice,
      gasLimit
    } = route.transactionRequest;

    let _gasParams = {};
    if (executionSettings?.setGasPrice) {
      _gasParams = maxPriorityFeePerGas
        ? { maxFeePerGas, maxPriorityFeePerGas, gasLimit }
        : { gasPrice, gasLimit };
    } else {
      _gasParams = { gasLimit };
    }

    let _overrides = overrides
      ? { ..._gasParams, ...overrides }
      : { ..._gasParams };

    if (_overrides.gasLimit) {
      _overrides = {
        ..._overrides,
        gasLimit: BigNumber.from(_overrides.gasLimit)
      };
    }

    if (!fromIsNative) {
      await this.validateBalanceAndApproval({
        fromTokenContract: fromTokenContract as ethers.Contract,
        targetAddress,
        fromProvider,
        fromIsNative,
        fromAmount: params.fromAmount,
        fromChain,
        infiniteApproval: executionSettings?.infiniteApproval,
        signer,
        overrides: _overrides
      });
    }

    const value = ethers.BigNumber.from(route.transactionRequest.value);

    let tx = {
      to: targetAddress,
      data: transactionRequest.data,
      ..._overrides
    } as ethers.utils.Deferrable<ethers.providers.TransactionRequest>;

    if (transactionRequest.routeType !== "SEND") {
      tx = {
        ...tx,
        value
      };
    }

    return await signer.sendTransaction(tx);
  }

  public getRawTxHex({
    nonce,
    route,
    overrides,
    executionSettings
  }: Omit<ExecuteRoute, "signer"> & { nonce: number }): string {
    if (!route.transactionRequest) {
      throw new SquidError({
        message: `transactionRequest property is missing in route object`,
        errorType: ErrorType.ValidationError,
        logging: this.config.logging,
        logLevel: this.config.logLevel
      });
    }

    const {
      gasLimit,
      gasPrice,
      targetAddress,
      data,
      maxPriorityFeePerGas,
      maxFeePerGas,
      value
    } = route.transactionRequest;

    let _gasParams = {
      gasLimit: BigNumber.from(gasLimit)
    } as any;

    if (executionSettings?.setGasPrice) {
      _gasParams = maxPriorityFeePerGas
        ? {
            ..._gasParams,
            maxFeePerGas: BigNumber.from(maxFeePerGas),
            maxPriorityFeePerGas: BigNumber.from(maxPriorityFeePerGas)
          }
        : { ..._gasParams, gasPrice: BigNumber.from(gasPrice) };
    } else {
      _gasParams = { ..._gasParams, gasPrice: BigNumber.from(gasPrice) };
    }

    const _overrides = overrides
      ? { ..._gasParams, ...overrides }
      : { ..._gasParams };

    return ethers.utils.serializeTransaction({
      chainId: parseInt(route.params.fromChain as string),
      to: targetAddress,
      data: data,
      value: BigNumber.from(value),
      nonce,
      ..._overrides
    } as UnsignedTransaction);
  }

  private async executeRouteCosmos(
    signer: SigningStargateClient,
    signerAddress: string,
    route: RouteData
  ): Promise<TxRaw> {
    const cosmosMsg: CosmosMsg = JSON.parse(route.transactionRequest!.data);
    const msgs = [];

    switch (cosmosMsg.msgTypeUrl) {
      case IBC_TRANSFER_TYPE: {
        msgs.push({
          typeUrl: cosmosMsg.msgTypeUrl,
          value: cosmosMsg.msg
        });

        break;
      }
      case WASM_TYPE: {
        // register execute wasm msg type for signer
        signer.registry.register(WASM_TYPE, MsgExecuteContract);

        const wasmHook = cosmosMsg.msg as WasmHookMsg;
        msgs.push({
          typeUrl: cosmosMsg.msgTypeUrl,
          value: {
            sender: signerAddress,
            contract: wasmHook.wasm.contract,
            msg: toUtf8(JSON.stringify(wasmHook.wasm.msg)),
            funds: [
              {
                denom: route.params.fromToken.address,
                amount: route.params.fromAmount
              }
            ]
          }
        });

        break;
      }
    }

    // validating that user has enough balance for the transfer
    await this.validateCosmosBalance(signer, signerAddress, {
      denom: route.params.fromToken.address,
      amount: route.params.fromAmount
    });

    // simulate tx to estimate gas cost
    const estimatedGas = await signer.simulate(signerAddress, msgs, "");
    const gasMultiplier = Number(route.transactionRequest!.maxFeePerGas) || 1.3;

    return signer.sign(
      signerAddress,
      msgs,
      calculateFee(
        Math.trunc(estimatedGas * gasMultiplier),
        GasPrice.fromString(route.transactionRequest!.gasPrice)
      ),
      ""
    );
  }

  public async isRouteApproved({ route, sender }: IsRouteApproved): Promise<{
    isApproved: boolean;
    message: string;
  }> {
    this.validateInit();

    const { fromIsNative, fromChain, fromProvider, fromTokenContract } =
      this.validateRouteParams(route.params);
    const { targetAddress } = this.validateTransactionRequest(
      route.transactionRequest
    );

    const {
      params: { fromAmount }
    } = route;

    const amount = ethers.BigNumber.from(fromAmount);

    if (!fromIsNative) {
      const balance = await (fromTokenContract as ethers.Contract).balanceOf(
        sender
      );

      if (amount.gt(balance)) {
        throw new SquidError({
          message: `Insufficient funds for account: ${sender} on chain ${fromChain.chainId}`,
          errorType: ErrorType.ValidationError,
          logging: this.config.logging,
          logLevel: this.config.logLevel
        });
      }

      const allowance = await (fromTokenContract as ethers.Contract).allowance(
        sender,
        targetAddress
      );

      if (amount.gt(allowance)) {
        throw new SquidError({
          message: `Insufficient allowance for contract: ${targetAddress} on chain ${fromChain.chainId}`,
          errorType: ErrorType.ValidationError,
          logging: this.config.logging,
          logLevel: this.config.logLevel
        });
      }

      return {
        isApproved: true,
        message: `User has approved Squid to use ${fromAmount} of ${await (
          fromTokenContract as ethers.Contract
        ).symbol()}`
      };
    } else {
      const balance = await fromProvider.getBalance(sender);

      if (amount.gt(balance)) {
        throw new SquidError({
          message: `Insufficient funds for account: ${sender} on chain ${fromChain.chainId}`,
          errorType: ErrorType.ValidationError,
          logging: this.config.logging,
          logLevel: this.config.logLevel
        });
      }

      return {
        isApproved: true,
        message: `User has the expected balance ${fromAmount} of ${fromChain.nativeCurrency.symbol}`
      };
    }
  }

  public async approveRoute({
    route,
    signer,
    executionSettings,
    overrides = {}
  }: ApproveRoute): Promise<boolean> {
    this.validateInit();

    const { fromIsNative, fromTokenContract } = this.validateRouteParams(
      route.params
    );

    const { targetAddress } = this.validateTransactionRequest(
      route.transactionRequest
    );

    const {
      params: { fromAmount }
    } = route as RouteData;

    if (fromIsNative) {
      return true;
    }

    let amountToApprove: BigNumber = ethers.BigNumber.from(uint256MaxValue);

    if (executionSettings?.infiniteApproval === false) {
      amountToApprove = ethers.BigNumber.from(fromAmount);
    }

    const approveTx = await (fromTokenContract as ethers.Contract)
      .connect(signer)
      .approve(targetAddress, amountToApprove, overrides);
    await approveTx.wait();

    return true;
  }

  public async allowance({
    owner,
    spender,
    tokenAddress,
    chainId
  }: Allowance): Promise<BigNumber> {
    this.validateInit();

    const token = getTokenData(
      this.tokens as TokenData[],
      tokenAddress,
      chainId
    );
    if (!token) {
      throw new SquidError({
        message: `Token not found for ${tokenAddress}`,
        errorType: ErrorType.ValidationError,
        logging: this.config.logging,
        logLevel: this.config.logLevel
      });
    }

    const chain = getChainData(
      this.chains as ChainData[],
      token.chainId as number
    );
    if (!chain) {
      throw new SquidError({
        message: `Chain not found for ${token.chainId}`,
        errorType: ErrorType.ValidationError,
        logging: this.config.logging,
        logLevel: this.config.logLevel
      });
    }

    const provider = new ethers.providers.JsonRpcProvider(chain.rpc);
    const contract = new ethers.Contract(token.address, erc20Abi, provider);
    return await contract.allowance(owner, spender);
  }

  public async approve({
    signer,
    spender,
    tokenAddress,
    amount,
    chainId,
    overrides
  }: Approve): Promise<ethers.providers.TransactionResponse> {
    this.validateInit();

    const token = getTokenData(
      this.tokens as TokenData[],
      tokenAddress,
      chainId as number | string
    );
    if (!token) {
      throw new SquidError({
        message: `Token not found for ${tokenAddress}`,
        errorType: ErrorType.ValidationError,
        logging: this.config.logging,
        logLevel: this.config.logLevel
      });
    }

    const chain = getChainData(
      this.chains as ChainData[],
      token.chainId as number | string
    );
    if (!chain) {
      throw new SquidError({
        message: `Chain not found for ${token.chainId}`,
        errorType: ErrorType.ValidationError,
        logging: this.config.logging,
        logLevel: this.config.logLevel
      });
    }

    const contract = new ethers.Contract(token.address, erc20Abi, signer);
    return await contract.approve(
      spender,
      amount || uint256MaxValue,
      overrides
    );
  }

  public async getStatus(params: GetStatus): Promise<StatusResponse> {
    const response = await this.axiosInstance.get("/v1/status", {
      params,
      headers: {
        ...(this.axiosInstance.defaults.headers.common &&
          this.axiosInstance.defaults.headers.common),
        ...(params.requestId && { "x-request-id": params.requestId }),
        ...(params.integratorId && { "x-integrator-id": params.integratorId })
      }
    });

    const statusResponse: StatusResponse = parseStatusResponse(
      response,
      response.headers
    );
    return statusResponse;
  }

  public async getTokenPrice({
    tokenAddress,
    chainId
  }: {
    tokenAddress: string;
    chainId: string | number;
  }) {
    const response = await this.axiosInstance.get("/v1/token-price", {
      params: { tokenAddress, chainId }
    });

    return response.data.price;
  }
}

export * from "./types";
