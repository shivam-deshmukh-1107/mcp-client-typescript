// src/mcp_server_publications.ts

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    CallToolRequestSchema as CallToolRequestSchema,
    ListToolsRequestSchema as ListToolsRequestSchema,
    ListResourcesRequestSchema as ListResourcesRequestSchema,
    ReadResourceRequestSchema,
    McpError,
    ErrorCode,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import fetch from "node-fetch";

// Base URL for the API
const API_BASE_URL = "https://web.sercuarc.org/api";

// Simple publication summary for search results
interface PublicationSummary {
    id: number;
    title: string;
    category: string;
    author: string;
    year: number;
}

async function fetchAllPublications(): Promise<any[]> {
    try {
        console.log("Fetching publications from API...");
        const res = await fetch(`${API_BASE_URL}/publications`, {
            headers: { Accept: "application/json" },
        });
        if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
        const data = await res.json();

        // Ensure we return an array
        if (!Array.isArray(data)) {
            throw new Error("API response is not an array");
        }

        return data;
    } catch (error) {
        throw new Error(`Failed to fetch publications: ${error instanceof Error ? error.message : String(error)}`);
    }
}

// Turn the raw object into our summary, joining all author names
function toSummary(pub: any): PublicationSummary {
    try {

        // Safely handle authors arrays
        const authors = (pub.authors || []).concat(pub.authors2 || []);
        const authorNames = authors
            .filter((a: any) => a && a.first_name && a.last_name) // Filter out invalid authors
            .map((a: any) => `${a.first_name} ${a.last_name}`)
            .join(", ");

        // Safely extract year from publication_date
        let year = 0;
        if (pub.publication_date && typeof pub.publication_date === 'string') {
            console.log(`Processing publication date: ${pub.publication_date}`);
            const yearMatch = pub.publication_date.match(/\d{4}/);
            year = yearMatch ? Number(yearMatch[0]) : 0;
        }

        const summary = {
            id: pub.id || 0,
            title: pub.title || 'Untitled',
            category: pub.category || 'Unknown',
            author: authorNames || 'Unknown Author',
            year: year,
        };

        return summary;
    } catch (error) {
        throw error;
    }
}

// Only keep pubs where *any* author's name matches
async function searchPublicationsByAuthor(
    authorTerm: string
): Promise<PublicationSummary[]> {
    try {
        const term = authorTerm.trim().toLowerCase();
        const all = await fetchAllPublications();

        const filtered = all.filter((pub) => {
            try {
                // Safely handle authors arrays
                const authors = (pub.authors || []).concat(pub.authors2 || []);
                return authors.some((a: any) => {
                    if (!a || !a.first_name || !a.last_name) return false;
                    const fullName = `${a.first_name} ${a.last_name}`.toLowerCase();
                    return fullName.includes(term);
                });
            } catch (error) {
                return false;
            }
        });

        // Process each publication safely
        const results: PublicationSummary[] = [];
        for (const pub of filtered) {
            try {
                results.push(toSummary(pub));
            } catch (error) {
                throw error
            }
        }

        return results;
    } catch (error) {
        console.error("Error in searchPublicationsByAuthor:", error);
        throw error;
    }
}

// Fetch a single publication by ID from the main publications list
async function getPublicationById(id: number): Promise<any> {
    try {
        // Since there's no individual endpoint, fetch all and find the one we want
        const allPublications = await fetchAllPublications();
        const publication = allPublications.find(pub => pub.id === id);

        if (!publication) {
            throw new Error(`Publication with ID ${id} not found`);
        }

        return publication;
    } catch (error) {
        throw error;
    }
}

// Initialize MCP server
async function start_Mcp_server(): Promise<void> {
    // Creating server instance
    const server = new Server(
        {
            name: "serc-publications-api",
            version: "1.0.0",
        },
        {
            capabilities: {
                resources: {
                    publications: {
                        search: {
                            description:
                                "Search for publications by author name and return a list with IDs, names, categories, title, and basic info",
                        },
                    },
                },
                tools: {
                    searchPublicationsByAuthor: {
                        description:
                            "Search for publications by author name and return a list with IDs, names, categories, title, and basic info",
                    },
                    getPublicationById: {
                        description:
                            "Get complete detailed information about a publication using its ID",
                    },
                },
            },
        }
    );

    // Tool Registration
    // Handle list tools request
    // The server registers two tools via ListToolsRequestSchema
    server.setRequestHandler(ListToolsRequestSchema, async () => {
        return {
            tools: [
                {
                    name: "searchPublicationsByAuthor",
                    description:
                        "Search for publications by author name and return a list with IDs, names, categories, title, and basic info",
                    inputSchema: {
                        type: "object",
                        properties: {
                            author: {
                                type: "string",
                                description:
                                    "The name or partial name of the author to search for",
                            },
                        },
                        required: ["author"],
                    },
                },
                {
                    name: "getPublicationById",
                    description:
                        "Get complete detailed information about a publication using its ID",
                    inputSchema: {
                        type: "object",
                        properties: {
                            id: {
                                type: "number",
                                description: "The ID of the publication to retrieve",
                            },
                        },
                        required: ["id"],
                    },
                },
            ],
        };
    });

    // Handle tool requests
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;

        switch (name) {
            case "searchPublicationsByAuthor": {
                // Fixed: Changed from "name" to "author" to match the schema
                const parsed = z.object({ author: z.string() }).safeParse(args);
                if (!parsed.success) {
                    throw new McpError(ErrorCode.InvalidParams, "Invalid parameters for searchPublicationsByAuthor");
                }

                // An MCP-level error with code InvalidParams
                if (!parsed.data.author.trim()) {
                    return {
                        content: [
                            {
                                type: "text",
                                text: "Please provide a valid author search term.",
                            },
                        ],
                    };
                }

                try {
                    const publications = await searchPublicationsByAuthor(parsed.data.author);

                    if (publications.length === 0) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `No publications found matching author: "${parsed.data.author}"`,
                                },
                            ],
                        };
                    }

                    // Formatting the results nicely with clear structure
                    const resultsText = publications.map((p, index) =>
                        `${index + 1}. Publication ID: ${p.id}
                        Title: ${p.title}
                        Author(s): ${p.author}
                        Category: ${p.category}
                        Year: ${p.year}`
                    ).join('\n\n');

                    return {
                        content: [
                            {
                                type: "text",
                                text: `Found ${publications.length} publication(s) matching "${parsed.data.author}":
                                ${resultsText}
                                Use the publication ID with getPublicationById to get complete details for any publication.`,
                            },
                        ],
                    };
                } catch (error) {
                    throw new McpError(
                        ErrorCode.InternalError,
                        `Error searching publications: ${error instanceof Error ? error.message : String(error)}`
                    );
                }
            }

            case "getPublicationById": {
                const parsed = z.object({ id: z.number() }).safeParse(args);
                if (!parsed.success) {
                    throw new McpError(ErrorCode.InvalidParams, "Invalid parameters for getPublicationById");
                }

                try {
                    const publication = await getPublicationById(parsed.data.id);

                    // Format ALL available publication data
                    const authors = (publication.authors || []).concat(publication.authors2 || []);
                    const authorDetails = authors
                        .filter((a: any) => a && a.first_name && a.last_name)
                        .map((a: any) => {
                            const prefix = a.prefix ? `${a.prefix} ` : '';
                            const organizations = (a.organizations || [])
                                .map((org: any) => org.organization_name)
                                .join(', ');
                            return `${prefix}${a.first_name} ${a.last_name}${organizations ? ` (${organizations})` : ''}`;
                        });

                    // Clean up HTML tags from abstract and description
                    const cleanAbstract = publication.abstract
                        ? publication.abstract.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
                        : 'No abstract available';

                    const cleanDescription = publication.description
                        ? publication.description.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
                        : 'No description available';

                    // Format projects information
                    const projects = (publication.projects || [])
                        .map((proj: any) => `${proj.project_title || 'Untitled Project'} (ID: ${proj.id})`)
                        .join(', ');

                    // Format research tasks
                    const researchTasks = (publication.research_tasks || [])
                        .map((task: any) => task.title || task.name || 'Untitled Task')
                        .join(', ');

                    // Format tags
                    const tags = (publication.tags || [])
                        .map((tag: any) => tag.name || tag.title || tag)
                        .join(', ');

                    const formattedResult = `
                    === PUBLICATION DETAILS ===

                    Title: ${publication.title || 'Untitled'}
                    ID: ${publication.id}
                    
                    Category: ${publication.category || 'Unknown'}

                    AUTHORS:
                    ${authorDetails.length > 0 ? authorDetails.map((author: any, i: number) => `  ${i + 1}. ${author}`).join('\n') : '  No authors listed'}

                    PUBLICATION INFORMATION:
                    Start Date: ${publication.start_date || 'N/A'}
                    Publication Date: ${publication.publication_date || 'Unknown'}
                    Event Name: ${publication.event_name || 'N/A'}
                    End Date: ${publication.end_date || 'N/A'}
                    Publisher: ${publication.publisher || 'N/A'}
                    Location: ${publication.location || 'N/A'}
                    ISBN: ${publication.isbn || 'N/A'}
                    Publication: ${publication.publication || 'N/A'}
                    
                    URL: ${publication.url || 'N/A'}

                    Contract Number: ${publication.contract_number || 'N/A'}
                    CONTRACT & DOCUMENT INFO:
                    Report Number: ${publication.report_number || 'N/A'}
                    Document ID: ${publication.document_id || 'N/A'}
                    
                    Production Date: ${publication.production_date || 'N/A'}

                    FILES & RESOURCES:
                    File: ${publication.file || 'No local file'}
                    File S3: ${publication.file_s3 || 'No S3 file available'}
                    Image: ${publication.image || 'No image'}
                    Image S3: ${publication.image_s3 || 'No S3 image'}

                    CONTENT:
                    Abstract: ${cleanAbstract}
                    Description: ${cleanDescription}

                    METADATA:
                    Created: ${publication.created_at || 'Unknown'}
                    Public: ${publication.public || 'Unknown'}
                    
                    Updated: ${publication.updated_at || 'Unknown'}

                    ASSOCIATED PROJECTS:
                    ${projects || 'No associated projects'}

                    RESEARCH TASKS:
                    
                    ${researchTasks || 'No research tasks'}
                    ${tags || 'No tags'}
                    
                    TAGS:
                    
                    `.trim();
                    return {
                        content: [
                            {
                                type: "text",
                                text: formattedResult,
                            },
                        ],
                    };
                } catch (error) {
                    throw new McpError(
                        ErrorCode.InternalError,
                        `Error retrieving publication: ${error instanceof Error ? error.message : String(error)}`
                    );
                }
            }

            default:
                throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
        }
    });

    // Handle resource requests (for listing all publications)
    server.setRequestHandler(ListResourcesRequestSchema, async () => {
        return {
            resources: [
                {
                    uri: "publications://search",
                    name: "Search Publications",
                    description:
                        "Search for publications by author name to get their IDs",
                    mimeType: "text/plain",
                },
            ],
        };
    });

    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
        const { uri } = request.params;

        if (uri === "publications://search") {
            return {
                contents: [
                    {
                        uri,
                        mimeType: "text/plain",
                        text: "To search for publications:\n1. Use searchPublicationsByAuthor to find publications and get their IDs\n2. Use getPublicationById with the ID to get complete details",
                    },
                ],
            };
        }

        throw new McpError(ErrorCode.InvalidRequest, `Unknown resource: ${uri}`);
    });

    // Start the server
    const transport = new StdioServerTransport();
    await server.connect(transport);
}

// Starting the server
start_Mcp_server().catch((error) => {
    console.error("Failed to start MCP server:", error);
    process.exit(1);
});