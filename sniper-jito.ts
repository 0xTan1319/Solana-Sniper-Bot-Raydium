import dotenv from "dotenv";
import path from "path";
import { Connection, Keypair } from "@solana/web3.js";
import { LiquidityPoolKeysV4 } from "@raydium-io/raydium-sdk";
import { initializeConfigurations, setupSnipeListMonitoring, sleep, getTokenMetadataInfo } from "./utils";
import { logger, TOKEN_SYMBOL_FILTER, USE_PENDING_SNIPE_LIST, CHECK_TOKEN_SYMBOL } from "./constants";
import { extractMarketAndLpInfoFromLogs, getPoolKeysFromMarketId } from "./swapUtils";

dotenv.config();

let seenSignatures = new Set<string>();
let pendingSnipeList: string[] = [];
const tokenSymbolToSnipe = TOKEN_SYMBOL_FILTER.toLowerCase();

const monitorNewTokens = async (connection: Connection, sniperWallet: Keypair) => {
    try {
        await initializeConfigurations();
        setupSnipeListMonitoring(pendingSnipeList, logger);
        logger.info(`Monitoring new Solana tokens...`);

        connection.onLogs("all", async ({ logs, err, signature }) => {
            if (err || seenSignatures.has(signature)) return;

            logger.info(`Found new token signature: ${signature}`);
            seenSignatures.add(signature);

            try {
                const parsedTransaction = await connection.getParsedTransaction(signature, {
                    maxSupportedTransactionVersion: 0,
                    commitment: "confirmed",
                });

                if (!parsedTransaction || parsedTransaction.meta?.err) return;
                logger.info(`Parsed transaction for signature: ${signature}`);

                const lpInfo = extractMarketAndLpInfoFromLogs(logs);
                const poolKeys: LiquidityPoolKeysV4 | null = await getPoolKeysFromMarketId(lpInfo.marketId, connection);

                if (!poolKeys) {
                    logger.error(`Unable to extract pool keys for signature: ${signature}`);
                    return;
                }

                const poolOpenTime = parseInt(poolKeys.poolOpenTime.toString());
                const currentTime = Math.floor(Date.now() / 1000);

                const isPendingPool = USE_PENDING_SNIPE_LIST && pendingSnipeList.includes(poolKeys.baseMint.toString());

                if (!isPendingPool) {
                    const tokenMetadata = await retrieveTokenMetadata(connection, poolKeys.baseMint.toString());
                    if (!tokenMetadata) return;

                    const matchTokenSymbol = CHECK_TOKEN_SYMBOL && tokenMetadata.symbol.toLowerCase() === tokenSymbolToSnipe;
                    if (!matchTokenSymbol) {
                        logger.info(`Skipping token ${poolKeys.baseMint}. Symbol doesn't match filter.`);
                        return;
                    }
                }

                if (poolOpenTime > currentTime) {
                    const delayMs = (poolOpenTime - currentTime) * 1000;
                    logger.info(`Delaying transaction for ${delayMs / 1000} seconds until pool open time.`);
                    await sleep(delayMs);
                }

                logger.info(`Executing actions for token ${poolKeys.baseMint}...`);
                // Additional logic to interact with the token can be added here

            } catch (error) {
                logger.error(`Error monitoring token: ${error.message}`, error);
            }
        });
    } catch (error) {
        logger.error(`Critical error starting token monitoring: ${error.message}`, error);
    }
};

const retrieveTokenMetadata = async (connection: Connection, baseMint: string) => {
    try {
        const tokenMetadata = await getTokenMetadataInfo(connection, baseMint);
        if (!tokenMetadata || !tokenMetadata.symbol) {
            logger.info(`Unable to retrieve metadata for token ${baseMint}. Skipping.`);
            return null;
        }
        return tokenMetadata;
    } catch (error) {
        logger.error(`Failed to retrieve token metadata: ${error.message}`);
        return null;
    }
};

export default monitorNewTokens;
