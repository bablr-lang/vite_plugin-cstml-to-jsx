/* global URL */

import { parseFrontmatter } from '@astrojs/markdown-remark';
import { reifyExpression } from '@bablr/agast-vm-helpers';
import { cstml, spam as m } from '@bablr/boot';

import * as jsLang from '@bablr/language-en-esnext';

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
  buildArrayElements,
  buildJSExpressionDeep,
  buildString,
} from '@bablr/helpers/builders';
import { printSource } from '@bablr/agast-helpers/tree';

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
  const isPage = fileId.includes('/pages/');
  if (isPage) {
    fileUrl = fileId.replace(/^.*?\/pages\//, sitePathname).replace(/(?:\/index)?\.mdx$/, '');
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

export default (astroConfig) => ({
  name: 'vite:transform-cstml-to-jsx',

  transform(code, id) {
    if (!id.endsWith('.cstml')) {
      return null;
    }

    const { frontmatter, content } = parseFrontmatter(code, { frontmatter: 'empty-with-spaces' });

    const document = reifyExpression(cstml.Document({ raw: [content.trim()] }));

    let stack = emptyStack.push({ type: null, node: null, fragment: null, langs: emptyStack });

    let tagPath = TagPath.fromNode(document, 0);
    let bindingTag;

    while (tagPath) {
      let { tag, path } = tagPath;

      if (tag.type === BindingTag) {
        bindingTag = tag;
      }

      if (tag.type === OpenNodeTag) {
        let { node } = tagPath;
        let { type } = tag.value;

        stack = stack.push({
          type,
          node,
          fragment: [],
          langs: stack.value.langs.concat(bindingTag?.value.languagePath ?? []),
        });
      }

      if (tag.type === LiteralTag) {
        let { value } = tag;
        stack = stack.replace({
          node: stack.value.node,
          type: stack.value.type,
          fragment: [...stack.value.fragment, ...buildTextChildren(value)],
          langs: stack.value.langs,
        });
      }

      if (tag.type === GapTag) {
        let span = getRoot(
          js`jsx('span', { class: 'gap', children: ['\u00A0\u00A0'] })
`.node,
        );

        stack.value.fragment = [stack.value.fragment, span];
      }

      if (tag.type === CloseNodeTag) {
        let doneFrame = stack.value;
        stack = stack.pop();

        let fragment;

        if (path.depth) {
          if (doneFrame.langs.size) {
            let { referenceTag } = path;

            let { node } = doneFrame;

            let span = getRoot(
              js`
                jsx('span', {
                  class: ${buildString(
                    classNames({
                      escape: referenceTag.value.type === '@',
                      token: node.flags.token,
                      trivia: referenceTag.value.type === '#',
                      hasGap: node.flags.hasGap,
                    }),
                  )},
                  children: ${buildArray(buildArrayElements(doneFrame.fragment))}
                })`.node,
            );

            fragment = span;
          } else {
            let type = doneFrame.node.type.description;
            if (type === 't') {
              stack = stack.replace({
                node: stack.value.node,
                type: stack.value.type,
                fragment: [...stack.value.fragment, ...doneFrame.fragment],
                langs: stack.value.langs,
              });
            } else {
              fragment = getRoot(
                js`jsx(${buildString(type)}, { children: ${buildArray(
                  buildArrayElements(doneFrame.fragment),
                )}, ...${buildJSExpressionDeep(doneFrame.node.attributes)} })`.node,
              );
            }
          }
        } else {
          ({ fragment } = doneFrame);

          if (!frontmatter.layout) throw new Error();

          const fileInfo = getFileInfo(id, astroConfig);

          let code = printSource(
            js.Program`import { Fragment, jsx } from "astro/jsx-runtime";
import { __astro_tag_component__ } from 'astro/runtime/server/index.js';
import Layout from ${buildString(frontmatter.layout)};
export const frontmatter = JSON.parse(${buildString(JSON.stringify(frontmatter))});

export const url = ${buildString(fileInfo.fileUrl)};
export const file = ${buildString(fileInfo.fileId)};

export const Content = () => {
  const { layout, ...content } = frontmatter;
  content.file = file;
  content.url = url;
  return jsx(Layout, {
    file,
    url,
    content,
    frontmatter: content,
    headings: getHeadings(),
    'server:root': true,
    children: [jsx('article', { children: ${buildArray(buildArrayElements(fragment))} })],
  });
};

__astro_tag_component__(Content, 'astro:jsx');

Content.moduleId = ${buildString(id)};

export function getHeadings() { return [] }

export default Content;`.node,
          );

          console.log(code);

          return { code, map: { mappings: '' } };
        }

        stack.value.fragment = [...(stack.value.fragment ?? []), fragment];
      }

      tagPath = tagPath.nextUnshifted;
    }
  },
});
