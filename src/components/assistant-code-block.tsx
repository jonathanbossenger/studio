import { Spinner } from '@wordpress/components';
import { __ } from '@wordpress/i18n';
import { Icon, archive, edit, preformatted } from '@wordpress/icons';
import { useCallback, useEffect, useState } from 'react';
import { ExtraProps } from 'react-markdown';
import stripAnsi from 'strip-ansi';
import { useRootSelector } from 'src/stores';
import { chatSelectors } from 'src/stores/chat-slice';
import { useExecuteWPCLI } from '../hooks/use-execute-cli';
import { useFeatureFlags } from '../hooks/use-feature-flags';
import { useIsValidWpCliInline } from '../hooks/use-is-valid-wp-cli-inline';
import { useSiteDetails } from '../hooks/use-site-details';
import { cx } from '../lib/cx';
import { getIpcApi } from '../lib/get-ipc-api';
import Button from './button';
import { ChatMessageProps } from './chat-message';
import { CopyTextButton } from './copy-text-button';
import { ExecuteIcon } from './icons/execute';

type ContextProps = {
	siteId: ChatMessageProps[ 'siteId' ];
	messageId?: number;
	instanceId: string;
};

export type CodeBlockProps = JSX.IntrinsicElements[ 'code' ] & ExtraProps;

export default function createCodeComponent( contextProps: ContextProps ) {
	return ( props: CodeBlockProps ) => <CodeBlock { ...contextProps } { ...props } />;
}

const LanguageBlock = ( props: ContextProps & CodeBlockProps ) => {
	const { children, className, node, siteId, messageId, instanceId, ...htmlAttributes } = props;

	const content = String( children ).trim();
	const isValidWpCliCommand = useIsValidWpCliInline( content );
	const { isRunning, handleExecute } = useExecuteWPCLI( content, instanceId, siteId, messageId );

	const messages = useRootSelector( ( state ) =>
		chatSelectors.selectMessages( state, instanceId )
	);
	const message = messages.find( ( { id } ) => id === messageId );
	const blocks = message?.blocks ?? [];

	const block = blocks?.find( ( block ) => block.codeBlockContent === content );
	const cliOutput = block?.cliOutput ? stripAnsi( block.cliOutput ) : null;
	const cliStatus = block?.cliStatus ?? null;
	const cliTime = block?.cliTime ?? null;

	const { terminalWpCliEnabled } = useFeatureFlags();
	const { selectedSite } = useSiteDetails();

	return (
		<>
			<div className="p-3">
				<code className={ className } { ...htmlAttributes }>
					{ children }
				</code>
			</div>
			<div className="p-3 pt-1 flex justify-start items-center">
				<CopyTextButton
					text={ content }
					label={ __( 'Copy' ) }
					copyConfirmation={ __( 'Copied!' ) }
					showText={ true }
					variant="outlined"
					className="h-auto mr-2 !px-2.5 py-0.5 !p-[6px] font-sans select-none"
					iconSize={ 16 }
					onCopied={ async () => {
						await getIpcApi().showNotification( {
							title: __( 'Copied to the clipboard' ),
						} );
					} }
				></CopyTextButton>
				{ [ 'language-sh', 'language-bash' ].includes( props.className || '' ) && selectedSite && (
					<Button
						icon={ preformatted }
						variant="outlined"
						className="h-auto mr-2 !px-2.5 py-0.5 font-sans select-none"
						iconSize={ 16 }
						onClick={ async () => {
							try {
								await getIpcApi().copyText( content );
								await getIpcApi().openTerminalAtPath( selectedSite.path, {
									wpCliEnabled: terminalWpCliEnabled,
								} );
								await getIpcApi().showNotification( {
									title: __( 'Command copied to the clipboard' ),
								} );
							} catch ( error ) {
								console.error( error );
							}
						} }
					>
						{ __( 'Open in terminal' ) }
					</Button>
				) }
				{ isValidWpCliCommand && (
					<Button
						icon={ <ExecuteIcon /> }
						onClick={ handleExecute }
						disabled={ isRunning }
						variant="outlined"
						className="h-auto mr-2 !px-2.5 py-0.5 font-sans select-none"
					>
						{ cliOutput ? __( 'Run again' ) : __( 'Run' ) }
					</Button>
				) }
			</div>
			{ isRunning && (
				<div className="p-3 flex justify-start items-center bg-[#2D3337] text-white">
					<Spinner className="!text-white [&>circle]:stroke-a8c-gray-60 !mt-0" />
					<span className="ml-2 font-sans">{ __( 'Running...' ) }</span>
				</div>
			) }
			{ ! isRunning && cliOutput && cliStatus && (
				<InlineCLI output={ cliOutput } status={ cliStatus } time={ cliTime } />
			) }
		</>
	);
};

function FileBlock( props: ContextProps & CodeBlockProps & { isDirectory?: boolean } ) {
	const {
		children,
		className,
		node,
		siteId,
		messageId,
		isDirectory,
		instanceId,
		...htmlAttributes
	} = props;
	const content = String( children ).trim();
	const [ filePath, setFilePath ] = useState( '' );

	const openFileInIDE = useCallback( () => {
		if ( ! siteId || ! filePath ) {
			return;
		}
		getIpcApi().openFileInIDE( content, siteId );
	}, [ siteId, filePath, content ] );

	const openFileInFinder = useCallback( () => {
		if ( ! siteId || ! filePath ) {
			return;
		}
		getIpcApi().openLocalPath( filePath );
	}, [ siteId, filePath ] );

	useEffect( () => {
		if ( ! siteId || ! content ) {
			return;
		}
		getIpcApi()
			.getAbsolutePathFromSite( siteId, content )
			.then( ( path ) => {
				if ( path ) {
					setFilePath( path );
				}
			} );
	}, [ siteId, content ] );

	return (
		<code
			{ ...htmlAttributes }
			className={ cx( className, filePath && 'file-block' ) }
			onClick={ isDirectory ? openFileInFinder : openFileInIDE }
		>
			{ children }
			{ filePath && (
				<Icon icon={ isDirectory ? archive : edit } className="rtl:scale-x-[-1]" size={ 16 } />
			) }
		</code>
	);
}

function CodeBlock( props: ContextProps & CodeBlockProps ) {
	const { children, className } = props;
	const content = String( children ).trim();
	const { node, siteId, messageId, instanceId, ...htmlAttributes } = props;

	const isFilePath = ( content: string ) => {
		const fileExtensions = [
			'.js',
			'.css',
			'.html',
			'.php',
			'.jsx',
			'.tsx',
			'.scss',
			'.less',
			'.log',
			'.md',
			'.json',
			'.txt',
			'.xml',
			'.yaml',
			'.yml',
			'.ini',
			'.env',
			'.sql',
		];
		return fileExtensions.some( ( ext ) => content.toLowerCase().endsWith( ext ) );
	};

	const isWPDirectory = ( content: string ) => {
		const wpPaths = [ 'wp-content', 'wp-includes', 'wp-admin' ];
		return wpPaths.some(
			( path ) => content.startsWith( path ) || content.startsWith( '/' + path )
		);
	};

	const inferContentType = () => {
		if ( /language-(\w+)/.exec( className || '' ) ) {
			return 'language';
		} else if ( isFilePath( content ) ) {
			return 'file';
		} else if ( isWPDirectory( content ) ) {
			return 'wp-directory';
		}
		return 'other';
	};

	switch ( inferContentType() ) {
		case 'language':
			return <LanguageBlock { ...props } />;
		case 'file':
			return <FileBlock { ...props } />;
		case 'wp-directory':
			return <FileBlock { ...props } isDirectory />;
		default:
			return (
				<code className={ className } { ...htmlAttributes }>
					{ children }
				</code>
			);
	}
}

interface InlineCLIProps {
	output?: string;
	status?: 'success' | 'error';
	time?: string | null;
}

function InlineCLI( { output, status, time }: InlineCLIProps ) {
	return (
		<div className="p-3 bg-[#2D3337]">
			<div className="flex justify-between mb-2 font-sans">
				<span className={ status === 'success' ? 'text-[#63CE68]' : 'text-[#E66D6C]' }>
					{ status === 'success' ? __( 'Success' ) : __( 'Error' ) }
				</span>
				<span className="text-gray-400">{ time }</span>
			</div>
			<pre className="text-white !bg-transparent !m-0 !px-0">
				<code className="!bg-transparent !mx-0 !px-0 !text-nowrap">{ output }</code>
			</pre>
		</div>
	);
}
