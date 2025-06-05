// src/mcp_server_researchers.ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    CallToolRequestSchema as CallToolRequestSchema,
    ListToolsRequestSchema as ListToolsRequestSchema,
    ListResourcesRequestSchema as ListResourcesRequestSchema,
    ReadResourceRequestSchema,
    McpError,
    ErrorCode
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import fetch from "node-fetch";

// Base URL for the API
const API_BASE_URL = "https://web.sercuarc.org/api";

// Simple person summary for search results
interface Person_Summary {
    id: number;
    name: string;
    type: string;
    organization?: string;
    email?: string;
}

// Search for people by name - returns simplified results
async function searchPeopleByName(search_term: string): Promise<Person_Summary[]> {
    try {
        // First, get all people (we'll optimize this later if the API supports search)
        const response = await fetch(`${API_BASE_URL}/people`, {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
            },
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json() as any[];
        const lowerSearchTerm = search_term.toLowerCase();

        // Filter and map to summary format
        const matches = data
            .filter(person => {
                const fullName = [
                    person.prefix,
                    person.first_name,
                    person.middle_name,
                    person.last_name,
                    person.suffix
                ]
                    .filter(Boolean)
                    .join(" ")
                    .toLowerCase();

                return fullName.includes(lowerSearchTerm) ||
                    (person.first_name && person.first_name.toLowerCase().includes(lowerSearchTerm)) ||
                    (person.last_name && person.last_name.toLowerCase().includes(lowerSearchTerm));
            })
            .map(person => ({
                id: person.id,
                name: [person.prefix, person.first_name, person.middle_name, person.last_name, person.suffix]
                    .filter(Boolean)
                    .join(" ")
                    .trim(),
                type: person.type || "Unknown",
                organization: person.organizations?.[0]?.organization_name,
                email: person.emails?.[0]?.email_address
            }));

        return matches;
    } catch (error) {
        throw error;
    }
}

// Get detailed information about a specific person by ID
async function get_person_by_Id(id: number): Promise<any> {
    try {
        // Usings the direct ID endpoint
        const response = await fetch(`${API_BASE_URL}/people/${id}`, {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
            },
        });

        if (!response.ok) {
            if (response.status === 404) {
                return null;
            }
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        return data;
    } catch (error) {
        throw error;
    }
}

// Initialize MCP server
async function start_Mcp_server(): Promise<void> {
    // Create server instance
    const server = new Server(
        {
            name: "serc-people-api",
            version: "1.0.0",
        },
        {
            capabilities: {
                resources: {},
                tools: {},
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
                    name: "searchPeopleByName",
                    description: "Search for people by name and return a list with IDs, names, types, and basic info",
                    inputSchema: {
                        type: "object",
                        properties: {
                            name: {
                                type: "string",
                                description: "The name or partial name to search for",
                            },
                        },
                        required: ["name"],
                    },
                },
                {
                    name: "getPersonById",
                    description: "Get complete detailed information about a person using their ID",
                    inputSchema: {
                        type: "object",
                        properties: {
                            id: {
                                type: "number",
                                description: "The ID of the person to retrieve",
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
            case "searchPeopleByName": {
                // Checking if name is string or not
                const parsed = z.object({ name: z.string() }).safeParse(args);
                if (!parsed.success) {
                    throw new McpError(ErrorCode.InvalidParams, "Invalid parameters for searchPeopleByName");
                }

                // An MCP-level error with code InvalidParams
                if (!parsed.data.name.trim()) {
                    return {
                        content: [
                            {
                                type: "text",
                                text: "Please provide a valid name search term.",
                            },
                        ],
                    };
                }

                try {
                    const people = await searchPeopleByName(parsed.data.name);

                    if (people.length === 0) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `No people found matching name: "${parsed.data.name}"`,
                                },
                            ],
                        };
                    }

                    // Formating the results nicely
                    const resultsText = people.map(p =>
                        `ID: ${p.id}\nName: ${p.name}\nType: ${p.type}${p.organization ? `\nOrganization: ${p.organization}` : ''}${p.email ? `\nEmail: ${p.email}` : ''}\n`
                    ).join('\n---\n');

                    return {
                        content: [
                            {
                                type: "text",
                                text: `Found ${people.length} people matching "${parsed.data.name}":\n\n${resultsText}`,
                            },
                        ],
                    };
                } catch (error) {
                    throw new McpError(
                        ErrorCode.InternalError,
                        `Error searching people: ${error instanceof Error ? error.message : String(error)}`
                    );
                }
            }

            case "getPersonById": {
                // Checking if ID is valid
                const parsed = z.object({ id: z.number() }).safeParse(args);
                if (!parsed.success) {
                    throw new McpError(ErrorCode.InvalidParams, "Invalid parameters for getPersonById");
                }

                try {
                    const data = await get_person_by_Id(parsed.data.id);

                    if (!data || !data.people) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `No person found with ID: ${parsed.data.id}`,
                                },
                            ],
                        };
                    }

                    // Showcasing the Data
                    const person = data.people;
                    const projects = data.projects || {};

                    // Format the person details in a comprehensive, readable way
                    const name = [person.prefix, person.first_name, person.middle_name, person.last_name, person.suffix]
                        .filter(Boolean)
                        .join(" ")
                        .trim();

                    let details = `PERSON DETAILS\n${'='.repeat(50)}\n\n`;

                    // Basic Information
                    details += `BASIC INFORMATION\n`;
                    details += `Name: ${name}\n`;
                    details += `ID: ${person.id}\n`;
                    details += `Type: ${person.type || 'Not specified'}\n`;
                    details += `Public: ${person.public || 'Not specified'}\n`;
                    details += `Active: ${person.active || 'Not specified'}\n`;
                    if (person.biography) {
                        details += `\nBiography:\n${person.biography.replace(/<[^>]*>/g, '')}\n`; // Removing HTML tags
                    }
                    if (person.image_s3) {
                        details += `\nProfile Image: ${person.image_s3}\n`;
                    }

                    // Contact Information
                    if (person.emails && person.emails.length > 0) {
                        details += `\nCONTACT INFORMATION\n`;
                        details += `Emails:\n`;
                        person.emails.forEach((email: any) => {
                            details += `  - ${email.email_address}${email.email_type ? ` (${email.email_type})` : ''}\n`;
                        });
                    }

                    if (person.phones && person.phones.length > 0) {
                        details += `\nPhones:\n`;
                        person.phones.forEach((phone: any) => {
                            if (phone.phone) {
                                details += `  - ${phone.phone}${phone.type ? ` (${phone.type})` : ''}\n`;
                            }
                        });
                    }

                    if (person.addresses && person.addresses.length > 0) {
                        details += `\nAddresses:\n`;
                        person.addresses.forEach((addr: any) => {
                            const parts = [addr.street, addr.city, addr.state, addr.postal_code, addr.country].filter(Boolean);
                            if (parts.length > 0) {
                                details += `  - ${parts.join(', ')}\n`;
                            }
                        });
                    }

                    // Professional Information
                    if (person.titles && person.titles.length > 0) {
                        details += `\nPROFESSIONAL INFORMATION\n`;
                        details += `Job Titles:\n`;
                        person.titles.forEach((title: any) => {
                            details += `  - ${title.job_title}`;
                            if (title.start_date || title.end_date) {
                                details += ` (${title.start_date || 'Unknown'} - ${title.end_date || 'Present'})`;
                            }
                            if (title.current === 'yes') {
                                details += ' [Current]';
                            }
                            details += '\n';
                        });
                    }

                    if (person.roles && person.roles.length > 0) {
                        details += `\nRoles:\n`;
                        person.roles.forEach((role: any) => {
                            details += `  - ${role.role_name}\n`;
                        });
                    }

                    if (person.organizations && person.organizations.length > 0) {
                        details += `\nOrganizations:\n`;
                        person.organizations.forEach((org: any) => {
                            details += `  - ${org.organization_name}`;
                            if (org.org_name_short) {
                                details += ` (${org.org_name_short})`;
                            }
                            details += '\n';
                            if (org.description) {
                                details += `    Description: ${org.description.replace(/<[^>]*>/g, '').substring(0, 200)}...\n`;
                            }
                        });
                    }

                    // Research Information
                    if (person.research_tasks && person.research_tasks.length > 0) {
                        details += `\nRESEARCH ACTIVITIES\n`;
                        details += `Research Tasks:\n`;
                        person.research_tasks.forEach((task: any) => {
                            details += `  - ${task.task_name}`;
                            if (task.task_number) {
                                details += ` (${task.task_number})`;
                            }
                            details += '\n';
                            if (task.period_start || task.period_end) {
                                details += `    Period: ${task.period_start || 'Unknown'} - ${task.period_end || 'Unknown'}\n`;
                            }
                            if (task.abstract) {
                                details += `    Abstract: ${task.abstract.replace(/<[^>]*>/g, '').substring(0, 200)}...\n`;
                            }

                            // Projects within tasks
                            if (task.projects && task.projects.length > 0) {
                                details += `    Associated Projects:\n`;
                                task.projects.forEach((proj: any) => {
                                    details += `      • ${proj.project_title} (ID: ${proj.id})\n`;
                                    if (proj.abstract) {
                                        details += `        ${proj.abstract.replace(/<[^>]*>/g, '').substring(0, 150)}...\n`;
                                    }
                                });
                            }

                            // Technical Reports
                            if (task.technical_reports && task.technical_reports.length > 0) {
                                details += `    Technical Reports:\n`;
                                task.technical_reports.forEach((report: any) => {
                                    details += `      • ${report.title} (${report.report_number})\n`;
                                    if (report.publication_date) {
                                        details += `        Published: ${report.publication_date}\n`;
                                    }
                                    if (report.contract_number) {
                                        details += `        Contract: ${report.contract_number}\n`;
                                    }
                                    if (report.file_s3) {
                                        details += `        PDF: ${report.file_s3}\n`;
                                    }
                                });
                            }
                        });
                    }

                    if (person.person_research_tasks && person.person_research_tasks.length > 0) {
                        details += `\nResearch Task Participation:\n`;
                        person.person_research_tasks.forEach((prt: any) => {
                            details += `  - Task ID ${prt.research_task_id}: ${prt.task_role || 'Participant'}`;
                            if (prt.start_date || prt.end_date) {
                                details += ` (${prt.start_date || 'Unknown'} - ${prt.end_date || 'Unknown'})`;
                            }
                            details += '\n';
                        });
                    }

                    // Authors sections
                    if (person.authors && person.authors.length > 0) {
                        details += `\nAuthorship (Primary):\n`;
                        person.authors.forEach((auth: any) => {
                            details += `  - ${JSON.stringify(auth)}\n`;
                        });
                    }

                    if (person.authors2 && person.authors2.length > 0) {
                        details += `\nAuthorship (Secondary):\n`;
                        person.authors2.forEach((auth: any) => {
                            details += `  - ${JSON.stringify(auth)}\n`;
                        });
                    }

                    // Citations
                    if (person.citation && person.citation.length > 0) {
                        details += `\nCITATIONS\n`;
                        person.citation.forEach((cit: any, index: number) => {
                            details += `  ${index + 1}. ${cit.citation}\n`;
                        });
                    }

                    // Associated Projects (from the projects object)
                    const projectList = Object.values(projects);
                    if (projectList.length > 0) {
                        details += `\nASSOCIATED PROJECTS (Detailed)\n`;
                        projectList.forEach((proj: any) => {
                            details += `  - ${proj.project_title} (ID: ${proj.id})\n`;
                            if (proj.abstract) {
                                details += `    Abstract: ${proj.abstract.replace(/<[^>]*>/g, '').substring(0, 200)}...\n`;
                            }
                            if (proj.transition) {
                                details += `    Transition: ${proj.transition.replace(/<[^>]*>/g, '').substring(0, 200)}...\n`;
                            }
                            if (proj.is_public) {
                                details += `    Public: ${proj.is_public}\n`;
                            }
                            if (proj.deliverable_summary) {
                                details += `    Deliverables: ${proj.deliverable_summary.replace(/<[^>]*>/g, '').substring(0, 200)}...\n`;
                            }
                        });
                    }

                    // Metadata
                    details += `\nMETADATA\n`;
                    if (person.created_at) details += `Created: ${person.created_at}\n`;
                    if (person.updated_at) details += `Last Updated: ${person.updated_at}\n`;

                    // Raw JSON link
                    details += `\n${'='.repeat(50)}\n`;
                    details += `For complete raw data, use the JSON format below:\n`;

                    return {
                        content: [
                            {
                                type: "text",
                                text: details,
                            },
                            {
                                type: "text",
                                text: `\nRAW JSON DATA:\n${JSON.stringify(data, null, 2)}`,
                            },
                        ],
                    };
                } catch (error) {
                    throw new McpError(
                        ErrorCode.InternalError,
                        `Error fetching person data: ${error instanceof Error ? error.message : String(error)}`
                    );
                }
            }

            default:
                throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
        }
    });

    // Handle resource requests (for listing all people)
    server.setRequestHandler(ListResourcesRequestSchema, async () => {
        return {
            resources: [
                {
                    uri: "people://search",
                    name: "Search People",
                    description: "Search for people by name to get their IDs",
                    mimeType: "text/plain",
                },
            ],
        };
    });

    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
        const { uri } = request.params;

        if (uri === "people://search") {
            return {
                contents: [
                    {
                        uri,
                        mimeType: "text/plain",
                        text: "To search for people:\n1. Use searchPeopleByName to find people and get their IDs\n2. Use getPersonById with the ID to get complete details",
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