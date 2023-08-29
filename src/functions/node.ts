/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */

import { bold, hideLinkEmbed, hyperlink, inlineCode, italic, underscore, userMention } from '@discordjs/builders';
import type { Response } from 'polka';
import TurndownService from 'turndown';
import { fetch } from 'undici';
import type { NodeDocs } from '../types/NodeDocs.js';
import { API_BASE_NODE, EMOJI_ID_NODE } from '../util/constants.js';
import { logger } from '../util/logger.js';
import { prepareErrorResponse, prepareResponse } from '../util/respond.js';

const td = new TurndownService({ codeBlockStyle: 'fenced' });

type QueryType = 'class' | 'classMethod' | 'event' | 'global' | 'method' | 'misc' | 'module';

function urlReplacer(_: string, label: string, link: string, version: string) {
	const resolvedLink = link.startsWith('http') ? link : `${API_BASE_NODE}/docs/${version}/api/${link}`;
	return hyperlink(label, hideLinkEmbed(resolvedLink));
}

function findRec(object: any, name: string, type: QueryType, module?: string, source?: string): any {
	const lowerName = name.toLowerCase();
	const resolvedModule = module ?? object?.type === 'module' ? object?.name.toLowerCase() : undefined;
	if (object?.name?.toLowerCase() === lowerName && object?.type === type) {
		object.module = resolvedModule;
		return object;
	}

	object._source = source;
	for (const prop of Object.keys(object)) {
		if (Array.isArray(object[prop])) {
			for (const entry of object[prop]) {
				const res = findRec(entry, name, type, module, object.source ?? object._source);
				if (res) {
					object.module = module;
					return res;
				}
			}
		}
	}
}

function formatForURL(text: string): string {
	return text
		.toLowerCase()
		.replaceAll(/[ )[]`]/g, '')
		.replaceAll(/[(,.:]/g, '_');
}

function formatAnchor(text: string, module: string): string {
	return `#${formatForURL(module)}_${formatForURL(text)}`;
}

function parseNameFromSource(source?: string): string | null {
	if (!source) return null;
	const reg = /.+\/api\/(.+)\..*/g;
	const match = reg.exec(source);
	return match?.[1] ?? null;
}

function findResult(data: any, query: string) {
	for (const category of ['class', 'classMethod', 'method', 'event', 'module', 'global', 'misc'] as QueryType[]) {
		const res = findRec(data, query, category);
		if (res) {
			// eslint-disable-next-line @typescript-eslint/no-unsafe-return
			return res;
		}
	}
}

const cache: Map<string, NodeDocs> = new Map();

export async function nodeSearch(
	res: Response,
	query: string,
	version = 'latest-v18.x',
	target?: string,
	ephemeral?: boolean,
): Promise<Response> {
	const trimmedQuery = query.trim();
	try {
		const url = `${API_BASE_NODE}/dist/${version}/docs/api/all.json`;
		let allNodeData = cache.get(url);

		if (!allNodeData) {
			// Get the data for this version
			const data = (await fetch(url).then(async (response) => response.json())) as NodeDocs;

			// Set it to the map for caching
			cache.set(url, data);

			// Set the local parameter for further processing
			allNodeData = data;
		}

		const queryParts = trimmedQuery.split(/[\s#.]/);
		const altQuery = queryParts[queryParts.length - 1];
		const result = findResult(allNodeData, trimmedQuery) ?? findResult(allNodeData, altQuery);

		if (!result) {
			prepareErrorResponse(res, `No result found for query ${inlineCode(trimmedQuery)}.`);
			return res;
		}

		const moduleName = result.module ?? result.name.toLowerCase();
		const moduleURL = `${API_BASE_NODE}/docs/${version}/api/${
			parseNameFromSource(result.source ?? result._source) ?? formatForURL(moduleName as string)
		}`;
		const anchor = ['module', 'misc'].includes(result.type) ? '' : formatAnchor(result.textRaw, moduleName as string);
		const fullURL = `${moduleURL}.html${anchor}`;
		const parts = [
			`<:node:${EMOJI_ID_NODE}>  ${underscore(bold(hyperlink(result.textRaw as string, hideLinkEmbed(fullURL))))}`,
		];

		const intro = td.turndown(result.desc ?? '').split('\n\n')[0];
		const linkReplaceRegex = /\[(.+?)]\((.+?)\)/g;
		const boldCodeBlockRegex = /`\*\*(.*)\*\*`/g;

		parts.push(
			intro
				.replaceAll(linkReplaceRegex, (_, label, link) => urlReplacer(_, label, link, version))
				.replaceAll(boldCodeBlockRegex, bold(inlineCode('$1'))),
		);
		prepareResponse(
			res,
			`${target ? `${italic(`Documentation suggestion for ${userMention(target)}:`)}\n` : ''}${parts.join('\n')}`,
			ephemeral ?? false,
			target ? [target] : [],
		);

		return res;
	} catch (error) {
		logger.error(error as Error);
		prepareErrorResponse(res, `Something went wrong.`);
		return res;
	}
}
