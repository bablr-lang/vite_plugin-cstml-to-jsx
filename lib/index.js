/* global URL */

import { reifyExpression } from '@bablr/agast-vm-helpers';
import Slugger from 'github-slugger';

import jsLang from '@bablr/language-en-esnext';

import { buildTag } from 'bablr';
import emptyStack from '@iter-tools/imm-stack';
import classNames from 'classnames';

import { getRoot, TagPath } from '@bablr/agast-helpers/path';
import {
  OpenNodeTag,
  CloseNodeTag,
  LiteralTag,
  GapTag,
  BindingTag,
} from '@bablr/agast-helpers/symbols';
import {
  buildArray,
  buildJSExpressionDeep,
  buildNumber,
  buildString,
} from '@bablr/helpers/builders';
import { printSource } from '@bablr/agast-helpers/tree';
import { parseTag } from '@bablr/agast-helpers/builders';
import { parseFrontmatter } from './frontmatter.js';
import { freezeRecord } from '@bablr/record';

Error.stackTraceLimit = 30;

let slugger = new Slugger();

// TODO why is this here? I tested and it is needed.
let js = buildTag(jsLang, m`<$Program />`);

function appendForwardSlash(path) {
  return path.endsWith('/') ? path : path + '/';
}

function getFileInfo(id, config) {
  const sitePathname = appendForwardSlash(
    config.site ? new URL(config.base, config.site).pathname : config.base,
  );

  // Try to grab the file's actual URL
  let url = undefined;
  try {
    url = new URL(`file://${id}`);
  } catch {}

  const fileId = id.split('?')[0];
  let fileUrl;
  const isPage = fileId.includes('/content/') || fileId.includes('/docs/');
  if (isPage) {
    fileUrl = fileId
      .replace(/^.*?\/(content|docs)\//, sitePathname)
      .replace(/(?:\/index)?\.cstml $/, '');
  } else if (url?.pathname.startsWith(config.root.pathname)) {
    fileUrl = url.pathname.slice(config.root.pathname.length);
  } else {
    fileUrl = fileId;
  }

  if (fileUrl && config.trailingSlash === 'always') {
    fileUrl = appendForwardSlash(fileUrl);
  }
  return { fileId, fileUrl };
}

let buildTextChildren = (value) => {
  let children = [];
  let literal = '';

  for (let chr of value) {
    if ('\n {}<>'.includes(chr)) {
      if (literal) {
        children.push(buildString(literal));
        literal = '';
      }

      children.push(buildString(chr));
    } else {
      literal += chr;
    }
  }

  if (literal) {
    children.push(buildString(literal));
  }

  return children;
};

let buildHeading = ({ depth, slug, text }) => {
  return js.Object`{ depth: ${buildNumber(depth)}, slug: ${buildString(slug)}, text: ${buildString(
    text,
  )} }`;
};

export { parseFrontmatter };

export default (astroConfig) => ({
  name: 'vite:transform-cstml-to-jsx',

  transform(code, id) {
    if (!id.endsWith('.cstml')) {
      return null;
    }

    const { frontmatter, content } = parseFrontmatter(code, { frontmatter: 'empty-with-spaces' });

    const document = reifyExpression(cstml.Document({ raw: [content.trim()] }));

    if (document.value.tree.value.type !== Symbol.for('__')) throw new Error();

    let stack = emptyStack.push({ name: null, node: null, fragment: null, langs: emptyStack });

    let highlighterImport = frontmatter.highlighter
      ? js.Statement`import Highlighter from ${buildString(frontmatter.highlighter)}`
      : null;

    let tagPath = TagPath.fromNode(document.value.tree, 0);
    let nextLangs = [];

    let headings = [];

    while (tagPath) {
      let { tag: tag_, path } = tagPath;

      let tag = parseTag(tag_);

      if (tag.type === BindingTag) {
        // TODO handle :..: :Lang: !
        nextLangs = nextLangz.push(tag.value);
      }

      if (tag.type === OpenNodeTag) {
        let { node } = tagPath;
        let { name } = tag.value;

        stack = stack.push({
          name,
          node,
          fragment: [],
          // TODO update me
          langs: nextLangs,
        });
        nextLangs = [];
      }

      if (tag.type === LiteralTag) {
        let { value } = tag;
        stack = stack.replace({
          node: stack.value.node,
          name: stack.value.name,
          fragment: [...stack.value.fragment, ...buildTextChildren(value)],
          langs: stack.value.langs,
        });
      }

      if (tag.type === GapTag) {
        let span = getRoot(
          js`jsx('span', { class: 'gap', children: ['\u00A0\u00A0'] })
`,
        );

        stack.value.fragment = [stack.value.fragment, span];
      }

      if (tag.type === CloseNodeTag || (tag.type === OpenNodeTag && tag.value.selfClosing)) {
        let doneFrame = stack.value;
        stack = stack.pop();

        let fragment;

        if (path.depth) {
          let { node, langs } = doneFrame;
          if (langs.length) {
            let { referenceTag } = path;

            let span = getRoot(
              js`
                jsx('span', {
                  class: ${buildString(
                    classNames({
                      escape: referenceTag?.value.type === '@',
                      token: node.value.flags.token,
                      trivia: referenceTag?.value.type === '#',
                      hasGap: node.value.flags.hasGap,
                    }),
                  )},
                  children: ${buildArray(doneFrame.fragment)}
                })`,
            );

            fragment = span;
          } else {
            let name = node.value.name?.description;
            let { tags, flags, attributes } = node.value;
            let { literalValue } = tags[1][0].value;

            if (!flags.token && literalValue) {
              name = stack.value.node.value.name;
            }

            literalValue ||= printSource(node);

            let result;
            if ((result = /^h([1-6])$/.exec(name))) {
              let slug = slugger.slug(literalValue);
              headings.push({
                depth: parseInt(result[1], 10),
                slug,
                text: literalValue,
              });

              attributes = freezeRecord({ ...attributes, id: slug });
            }

            fragment = getRoot(
              !name
                ? buildString(literalValue)
                : js`jsx(${buildString(name)}, { children: ${buildArray(
                    doneFrame.fragment,
                  )}, ...${buildJSExpressionDeep(attributes)} })`,
            );

            if (name === 'code' && frontmatter.highlighter) {
              fragment = getRoot(js`jsx(Highlighter, { children: ${fragment} })`);
            }
          }
        } else {
          ({ fragment } = doneFrame);

          if (!frontmatter.layout) throw new Error();

          const fileInfo = getFileInfo(id, astroConfig);

          let page = js`jsx('article', { children: ${buildArray(fragment)} })`;

          let code = printSource(
            js.Program`import { Fragment, jsx } from "astro/jsx-runtime";
import { __astro_tag_component__ } from 'astro/runtime/server/index.js';
${highlighterImport}
import Layout from ${buildString(frontmatter.layout)};
export const frontmatter = JSON.parse(${buildString(JSON.stringify(frontmatter))});

export const url = ${buildString(fileInfo.fileUrl)};
export const file = ${buildString(fileInfo.fileId)};

export const Content = () => {
  const { layout, ...content } = frontmatter;
  content.file = file;
  content.url = url;
  return jsx(Fragment, {
    children: [jsx(Layout, {
      file,
      url,
      frontmatter: content,
      headings: getHeadings(),
      'server:root': true,
      children: [${page}],
    })],
  });
};

__astro_tag_component__(Content, 'astro:jsx');


export function getHeadings() {
  return ${buildArray(headings.map(buildHeading))};
}

export default Content;`,
          );

          return { code, map: { mappings: '' } };
        }

        stack.value.fragment = [...(stack.value.fragment ?? []), fragment];
      }

      tagPath = tagPath.nextUnshifted;
    }
  },
});
