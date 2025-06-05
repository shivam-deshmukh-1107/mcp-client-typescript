// src/index.ts
import dotenv from "dotenv";
dotenv.config();

import fetch from "node-fetch";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import readline from "readline/promises";

const TOGETHER_API_KEY = process.env.TOGETHER_API_KEY;
const TOGETHER_BASE_URL = process.env.TOGETHER_BASE_URL;

if (!TOGETHER_API_KEY || !TOGETHER_BASE_URL) {
    throw new Error("Missing Together.ai API key or base URL");
}

class MCPClient {
    private mcpPeople: Client;
    private mcpPubs: Client;
    private transportPeople: StdioClientTransport | null = null;
    private transportPubs: StdioClientTransport | null = null;

    constructor() {
        this.mcpPeople = new Client({ name: "mcp-people", version: "1.0.0" });
        this.mcpPubs = new Client({ name: "mcp-pubs", version: "1.0.0" });
    }

    async connectToServers(peopleServerPath: string, pubServerPath: string) {
        const command = process.execPath;

        this.transportPeople = new StdioClientTransport({ command, args: [peopleServerPath] });
        this.transportPubs = new StdioClientTransport({ command, args: [pubServerPath] });

        this.mcpPeople.connect(this.transportPeople);
        this.mcpPubs.connect(this.transportPubs);

        console.log("Connected to both MCP servers.");
    }

    async processQuery(query: string) {
        const messages = [
            {
                role: "system",
                content: `
                You are a helpful assistant using two MCP servers. You must ONLY use the following tools:
    
                - TOOL:searchPeopleByName {"name": "Tam Chantem"}
                - TOOL:getPersonById {"id": 123}
                - TOOL:searchPublicationsByAuthor {"author": "John Smith"}
                - TOOL:getPublicationById {"id": 456}
    
                When a user asks for a person or publication, use the search tool first to get the ID, then call the get-by-ID tool.
    
                ONLY respond with one tool call per message. Do NOT add explanation text or multiple TOOL lines. Format:
                TOOL:toolName {"param": "value"}

                `,
            },
            { role: "user", content: query },
        ];

        const response = await fetch(`${TOGETHER_BASE_URL}/chat/completions`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${TOGETHER_API_KEY}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                model: "mistralai/Mixtral-8x7B-Instruct-v0.1",
                messages,
                temperature: 0.5,
                max_tokens: 800,
            }),
        });
        const result = await response.json() as {
            choices?: Array<{
                message?: {
                    content?: string;
                };
            }>;
        };
        const output = result.choices?.[0]?.message?.content || "";
        console.log("LLM Output:\n" + output);

        const match = output.match(/TOOL:(\w+)\s+({[^}]*})/);
        if (!match) {
            console.log("No tool pattern detected.");
            return output;
        }

        const toolName = match[1].trim();
        let argJsonRaw = match[2].trim();

        // Safely try to parse JSON
        let args: any;
        try {
            args = JSON.parse(argJsonRaw);
        } catch (err) {
            console.error("⚠️ Failed to parse tool arguments:\n", argJsonRaw);
            throw err;
        }


        console.log(`Executing: ${toolName} with args: ${argJsonRaw}`);
        const toolResult = await (toolName.startsWith('searchPeopleByName') || toolName === 'getPersonById'
            ? this.mcpPeople
            : this.mcpPubs).callTool({ name: toolName, arguments: args });

        // Extract tool result text
        const textOutput = (toolResult.content as any[])
            .filter(c => c.type === "text")
            .map(c => c.text)
            .join("\n");

        // Auto-follow-up for get-by-ID if it's a search tool
        if (toolName === "searchPeopleByName" || toolName === "searchPublicationsByAuthor") {
            const idMatch = textOutput.match(/ID:\s*(\d+)/);
            if (!idMatch) {
                return `Search complete, but no valid ID found:\n${textOutput}`;
            }

            const id = parseInt(idMatch[1]);
            const followupTool = toolName === "searchPeopleByName" ? "getPersonById" : "getPublicationById";

            console.log(`Auto-following up with ${followupTool} for ID: ${id}`);
            const detailResult = await (followupTool.startsWith('searchPeopleByName') || followupTool === 'getPersonById'
                ? this.mcpPeople
                : this.mcpPubs).callTool({ name: followupTool, arguments: { id } });

            const fullDetails = (detailResult.content as any[])
                .filter(c => c.type === "text")
                .map(c => c.text)
                .join("\n");

            return `Search Result:\n${textOutput}\n\nDetailed Info:\n${fullDetails}`;
        }

        return `Tool Output:\n${textOutput}`;
    }


    formatContent(toolResult: any): string {
        return (toolResult.content as any[])
            .map((c) => (c.type === "text" ? c.text : ""))
            .join("\n");
    }

    async chatLoop() {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        console.log("\nMCP Client Started\nType your queries or 'quit' to exit.");

        while (true) {
            const query = await rl.question("\nQuery: ");
            if (query.toLowerCase() === "quit") break;

            try {
                const response = await this.processQuery(query);
                console.log("\n" + response);
            } catch (err) {
                console.error("Error:", err);
            }
        }

        rl.close();
    }

    async cleanup() {
        await this.mcpPeople.close();
        await this.mcpPubs.close();
    }
}

async function main() {
    const peopleServer = process.argv[2];
    const pubServer = process.argv[3];

    if (!peopleServer || !pubServer) {
        console.log("Usage: node build/src/index.js build/src/mcp_server_researchers.js build/src/mcp_server_publications.js");
        return;
    }

    const client = new MCPClient();
    try {
        await client.connectToServers(peopleServer, pubServer);
        await client.chatLoop();
    } finally {
        await client.cleanup();
        process.exit(0);
    }
}

main();
