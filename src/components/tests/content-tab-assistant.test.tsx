import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { Provider } from 'react-redux';
import {
	ContentTabAssistant,
	MIMIC_CONVERSATION_DELAY,
} from 'src/components/content-tab-assistant';
import { LOCAL_STORAGE_CHAT_MESSAGES_KEY, CLEAR_HISTORY_REMINDER_TIME } from 'src/constants';
import { useAuth } from 'src/hooks/use-auth';
import { useGetWpVersion } from 'src/hooks/use-get-wp-version';
import { useOffline } from 'src/hooks/use-offline';
import { usePromptUsage } from 'src/hooks/use-prompt-usage';
import { ThemeDetailsProvider } from 'src/hooks/use-theme-details';
import { useWelcomeMessages } from 'src/hooks/use-welcome-messages';
import { getIpcApi } from 'src/lib/get-ipc-api';
import { store } from 'src/stores';
import { generateMessage, chatActions } from 'src/stores/chat-slice';
import { testActions, testReducer } from 'src/stores/tests/utils/test-reducer';

store.replaceReducer( testReducer );

jest.mock( '../../hooks/use-auth' );
jest.mock( '../../hooks/use-welcome-messages' );
jest.mock( '../../hooks/use-offline' );
jest.mock( '../../hooks/use-prompt-usage' );
jest.mock( '../../lib/get-ipc-api' );
jest.mock( '../../hooks/use-get-wp-version' );

jest.mock( '../../lib/app-globals', () => ( {
	getAppGlobals: () => ( {
		locale: jest.fn,
	} ),
} ) );

( useWelcomeMessages as jest.Mock ).mockReturnValue( {
	messages: [ 'Welcome to our service!', 'How can I help you today?' ],
	examplePrompts: [
		'How to create a WordPress site',
		'How to clear cache',
		'How to install a plugin',
	],
} );

const runningSite = {
	name: 'Test Site',
	port: 8881,
	path: '/path/to/site',
	running: true,
	phpVersion: '8.0',
	id: 'site-id',
	url: 'http://example.com',
};

const initialMessages = [
	generateMessage( 'Initial message 1', 'user', 0, 'chat-id', 10 ),
	generateMessage( 'Initial message 2', 'assistant', 1, 'chat-id', 11 ),
];

function ContextWrapper( props: Parameters< typeof ContentTabAssistant >[ 0 ] ) {
	return (
		<Provider store={ store }>
			<ThemeDetailsProvider>
				<ContentTabAssistant { ...props } />
			</ThemeDetailsProvider>
		</Provider>
	);
}

describe( 'ContentTabAssistant', () => {
	const clientReqPost = jest.fn().mockImplementation( ( params, callback ) => {
		callback(
			null,
			{
				id: 'chatcmpl-9USNsuhHWYsPAUNiOhOG2970Hjwwb',
				object: 'chat.completion',
				created: 1717045976,
				model: 'test',
				choices: [
					{
						index: 0,
						message: {
							id: 0,
							role: 'assistant',
							content:
								'Hello! How can I assist you today? Are you working on a WordPress project, or do you need help with something specific related to WordPress or WP-CLI?',
						},
						logprobs: null,
						finish_reason: 'stop',
					},
				],
				usage: { prompt_tokens: 980, completion_tokens: 36, total_tokens: 1016 },
				system_fingerprint: 'fp_777',
			},
			{
				'x-quota-max': '100',
				'x-quota-remaining': '99',
			}
		);
	} );

	const authenticate = jest.fn();

	const getInput = () => screen.getByTestId( 'ai-input-textarea' );

	const getGuidelinesLink = () => screen.getByTestId( 'guidelines-link' ) as HTMLAnchorElement;

	beforeEach( () => {
		jest.clearAllMocks();
		window.HTMLElement.prototype.scrollIntoView = jest.fn();
		localStorage.clear();

		// Reset Redux store state
		store.dispatch( testActions.resetState() );

		( useAuth as jest.Mock ).mockReturnValue( {
			client: { req: { post: clientReqPost } },
			isAuthenticated: true,
			authenticate,
		} );
		( useOffline as jest.Mock ).mockReturnValue( false );
		( usePromptUsage as jest.Mock ).mockReturnValue( { userCanSendMessage: true } );
		( getIpcApi as jest.Mock ).mockReturnValue( {
			showMessageBox: jest.fn().mockResolvedValue( { response: 0, checkboxChecked: false } ),
			executeWPCLiInline: jest.fn().mockResolvedValue( { stdout: '', stderr: 'Error' } ),
		} );
		( useGetWpVersion as jest.Mock ).mockReturnValue( '6.4.3' );
	} );

	it( 'renders placeholder text input', () => {
		render( <ContextWrapper selectedSite={ runningSite } /> );
		const textInput = getInput();
		expect( textInput ).toBeVisible();
		expect( textInput ).toBeEnabled();
		expect( textInput ).toHaveAttribute( 'placeholder', 'What would you like to learn?' );
	} );

	it( 'renders guideline section', () => {
		render( <ContextWrapper selectedSite={ runningSite } /> );
		const guideLines = getGuidelinesLink();
		expect( guideLines ).toBeVisible();
		expect( guideLines ).toHaveTextContent( 'Powered by experimental AI. Learn more' );
	} );

	it( 'saves and retrieves conversation from Redux state', async () => {
		store.dispatch(
			chatActions.setMessages( { instanceId: runningSite.id, messages: initialMessages } )
		);
		render( <ContextWrapper selectedSite={ runningSite } /> );
		await waitFor( () => {
			expect( screen.getByText( 'Initial message 1' ) ).toBeVisible();
			expect( screen.getByText( 'Initial message 2' ) ).toBeVisible();
		} );

		const textInput = getInput();
		act( () => {
			fireEvent.change( textInput, { target: { value: 'New message' } } );
			fireEvent.keyDown( textInput, { key: 'Enter', code: 'Enter' } );
		} );

		await waitFor( () => {
			expect( screen.getByText( 'New message' ) ).toBeInTheDocument();
		} );

		await waitFor( () => {
			const storedMessages = JSON.parse(
				localStorage.getItem( LOCAL_STORAGE_CHAT_MESSAGES_KEY ) || '[]'
			);
			expect( storedMessages[ runningSite.id ] ).toHaveLength( 4 );
			expect( storedMessages[ runningSite.id ][ 2 ].content ).toBe( 'New message' );
		} );
	} );

	it( 'renders default message when not authenticated', async () => {
		( useAuth as jest.Mock ).mockReturnValue( {
			client: { req: { post: clientReqPost } },
			isAuthenticated: false,
			authenticate,
		} );
		render( <ContextWrapper selectedSite={ runningSite } /> );

		await waitFor( () => {
			expect( screen.getByText( 'Hold up!' ) ).toBeVisible();
			expect(
				screen.getByText( 'You need to log in to your WordPress.com account to use the assistant.' )
			).toBeVisible();
		} );
	} );

	it( 'renders offline notice when not authenticated', () => {
		( useAuth as jest.Mock ).mockReturnValue( {
			client: { req: { post: clientReqPost } },
			isAuthenticated: false,
			authenticate,
		} );
		( useOffline as jest.Mock ).mockReturnValue( true );

		render( <ContextWrapper selectedSite={ runningSite } /> );
		expect( screen.queryByText( 'Hold up!' ) ).not.toBeInTheDocument();
		expect(
			screen.queryByText( 'You need to log in to your WordPress.com account to use the assistant.' )
		).not.toBeInTheDocument();
		expect( screen.getByText( 'The AI assistant requires an internet connection.' ) ).toBeVisible();
	} );

	it( 'allows authentication from Assistant chat', async () => {
		( useAuth as jest.Mock ).mockReturnValue( {
			client: { req: { post: clientReqPost } },
			isAuthenticated: false,
			authenticate,
		} );
		render( <ContextWrapper selectedSite={ runningSite } /> );

		await waitFor( () => {
			const loginButton = screen.getByRole( 'button', { name: 'Log in to WordPress.com' } );
			expect( loginButton ).toBeInTheDocument();
		} );

		const loginButton = screen.getByRole( 'button', { name: 'Log in to WordPress.com' } );
		fireEvent.click( loginButton );
		expect( authenticate ).toHaveBeenCalledTimes( 1 );
	} );

	it( 'it stores messages with user-unique keys', async () => {
		const user1 = { id: 'mock-user-1' };
		const user2 = { id: 'mock-user-2' };
		( useAuth as jest.Mock ).mockReturnValue( {
			client: { req: { post: clientReqPost } },
			isAuthenticated: true,
			authenticate,
			user: user1,
		} );
		const { rerender } = render( <ContextWrapper selectedSite={ runningSite } /> );

		const textInput = getInput();
		act( () => {
			fireEvent.change( textInput, { target: { value: 'New message' } } );
			fireEvent.keyDown( textInput, { key: 'Enter', code: 'Enter' } );
		} );
		await waitFor( () => {
			expect( screen.getByText( 'New message' ) ).toBeVisible();
		} );

		// Simulate user authentication change
		( useAuth as jest.Mock ).mockReturnValue( {
			client: { req: { post: clientReqPost } },
			isAuthenticated: true,
			authenticate,
			user: user2,
		} );

		rerender( <ContextWrapper selectedSite={ runningSite } /> );

		await waitFor(
			() => {
				expect( screen.queryByText( 'New message' ) ).not.toBeInTheDocument();
			},
			{ timeout: MIMIC_CONVERSATION_DELAY + 1000 }
		);
	} );

	it( 'does not render the Welcome messages and example prompts when not authenticated', () => {
		( useAuth as jest.Mock ).mockReturnValue( {
			client: { req: { post: clientReqPost } },
			isAuthenticated: false,
			authenticate,
		} );
		render( <ContextWrapper selectedSite={ runningSite } /> );

		expect( screen.getByTestId( 'unauthenticated-header' ) ).toHaveTextContent( 'Hold up!' );

		expect( screen.queryByText( 'Welcome to our service!' ) ).not.toBeInTheDocument();
	} );

	it( 'renders Welcome messages and example prompts when the conversation is starts', () => {
		store.dispatch( chatActions.setMessages( { instanceId: runningSite.id, messages: [] } ) );
		render( <ContextWrapper selectedSite={ runningSite } /> );

		expect( screen.getByText( 'Welcome to our service!' ) ).toBeVisible();
		expect( screen.getByText( 'How to create a WordPress site' ) ).toBeVisible();
		expect( screen.getByText( 'How to clear cache' ) ).toBeVisible();
		expect( screen.getByText( 'How to install a plugin' ) ).toBeVisible();
	} );

	it( 'renders Welcome messages and example prompts when offline', () => {
		store.dispatch( chatActions.setMessages( { instanceId: runningSite.id, messages: [] } ) );
		( useOffline as jest.Mock ).mockReturnValue( true );

		render( <ContextWrapper selectedSite={ runningSite } /> );
		expect( screen.getByText( 'Welcome to our service!' ) ).toBeVisible();
		expect( screen.getByText( 'How to create a WordPress site' ) ).toBeVisible();
		expect( screen.getByText( 'How to clear cache' ) ).toBeVisible();
		expect( screen.getByText( 'How to install a plugin' ) ).toBeVisible();
		expect( screen.getByText( 'The AI assistant requires an internet connection.' ) ).toBeVisible();
	} );

	it( 'should manage the focus state when selecting an example prompt', async () => {
		const delayedClientReqPost = jest.fn().mockImplementation( () => {
			// Never resolve
		} );

		( useAuth as jest.Mock ).mockReturnValue( {
			client: { req: { post: delayedClientReqPost } },
			isAuthenticated: true,
			authenticate,
		} );

		store.dispatch( chatActions.setMessages( { instanceId: runningSite.id, messages: [] } ) );
		jest.useRealTimers();
		const user = userEvent.setup();
		render( <ContextWrapper selectedSite={ runningSite } /> );

		const textInput = getInput();
		await user.type( textInput, '[Tab]' );
		expect( textInput ).not.toHaveFocus();

		const samplePrompt = await screen.findByRole( 'button', {
			name: 'How to create a WordPress site',
		} );
		expect( samplePrompt ).toBeVisible();
		await user.click( samplePrompt );

		expect( textInput ).toHaveAttribute( 'placeholder', 'Thinking about that…' );
	} );

	it( 'renders the selected prompt of Welcome messages and confirms other prompts are removed', async () => {
		store.dispatch( chatActions.setMessages( { instanceId: runningSite.id, messages: [] } ) );

		render( <ContextWrapper selectedSite={ runningSite } /> );

		await waitFor( () => {
			expect( screen.getByText( 'Welcome to our service!' ) ).toBeInTheDocument();
			expect( screen.getByText( 'How to create a WordPress site' ) ).toBeInTheDocument();
			expect( screen.getByText( 'How to install a plugin' ) ).toBeInTheDocument();
		} );

		const samplePrompt = await screen.findByRole( 'button', {
			name: 'How to create a WordPress site',
		} );
		fireEvent.click( samplePrompt );

		await waitFor(
			() => {
				expect( screen.getByText( 'Welcome to our service!' ) ).toBeInTheDocument();
				expect( screen.getByText( 'How to create a WordPress site' ) ).toBeInTheDocument();
				expect( screen.queryByText( 'How to clear cache' ) ).not.toBeInTheDocument();
				expect( screen.queryByText( 'How to install a plugin' ) ).not.toBeInTheDocument();
			},
			{ timeout: MIMIC_CONVERSATION_DELAY + 1000 }
		);
	} );

	it( 'clears history via reminder when last message is two hours old', async () => {
		const MOCKED_CURRENT_TIME = 1718882159928;
		const OLD_MESSAGE_TIME = MOCKED_CURRENT_TIME - CLEAR_HISTORY_REMINDER_TIME - 1;
		jest.useFakeTimers();
		jest.setSystemTime( MOCKED_CURRENT_TIME );

		const messageOne = generateMessage( 'Initial message 1', 'user', 0, 'hej', 10 );
		messageOne.createdAt = MOCKED_CURRENT_TIME;
		const messageTwo = generateMessage( 'Initial message 2', 'assistant', 1, 'hej', 11 );
		messageTwo.createdAt = OLD_MESSAGE_TIME;
		store.dispatch(
			chatActions.setMessages( {
				instanceId: runningSite.id,
				messages: [ messageOne, messageTwo ],
			} )
		);

		( getIpcApi as jest.Mock ).mockReturnValue( {
			showMessageBox: jest.fn().mockResolvedValue( { response: 0, checkboxChecked: false } ),
			executeWPCLiInline: jest.fn().mockResolvedValue( { stdout: '', stderr: 'Error' } ),
		} );

		render( <ContextWrapper selectedSite={ runningSite } /> );

		await waitFor(
			() => {
				expect( screen.getByText( 'Welcome to our service!' ) ).toBeVisible();
				expect( screen.getByText( 'Initial message 1' ) ).toBeVisible();
				expect( screen.getByText( 'Initial message 2' ) ).toBeVisible();
				expect(
					screen.getByText( 'This conversation is over two hours old.', { exact: false } )
				).toBeVisible();
			},
			{ timeout: MIMIC_CONVERSATION_DELAY + 1000 }
		);

		fireEvent.click( screen.getByRole( 'button', { name: 'Clear the history' } ) );
		await waitFor(
			() => {
				expect( getIpcApi().showMessageBox ).toHaveBeenCalledTimes( 1 );
				expect( screen.queryByText( 'Initial message 1' ) ).not.toBeInTheDocument();
				expect( screen.queryByText( 'Initial message 2' ) ).not.toBeInTheDocument();
			},
			{ timeout: MIMIC_CONVERSATION_DELAY + 1000 }
		);
		jest.useRealTimers();
	} );

	it( 'renders notices by importance', async () => {
		const messageOne = generateMessage( 'Initial message 1', 'user', 0, 'chat-id', 10 );
		messageOne.createdAt = 0;
		const messageTwo = generateMessage( 'Initial message 2', 'assistant', 1, 'chat-id', 11 );
		messageTwo.createdAt = 0;
		store.dispatch(
			chatActions.setMessages( {
				instanceId: runningSite.id,
				messages: [ messageOne, messageTwo ],
			} )
		);

		const { rerender } = render( <ContextWrapper selectedSite={ runningSite } /> );
		await waitFor(
			() => {
				expect( screen.getByText( 'Welcome to our service!' ) ).toBeVisible();
				expect( screen.getByText( 'Initial message 1' ) ).toBeVisible();
				expect( screen.getByText( 'Initial message 2' ) ).toBeVisible();
				expect(
					screen.getByText( 'This conversation is over two hours old.', { exact: false } )
				).toBeVisible();
			},
			{ timeout: MIMIC_CONVERSATION_DELAY + 2000 }
		);

		( usePromptUsage as jest.Mock ).mockReturnValue( {
			userCanSendMessage: false,
			daysUntilReset: 4,
		} );
		rerender( <ContextWrapper selectedSite={ runningSite } /> );
		expect(
			screen.getByText( 'Your limit will reset in 4 days.', { exact: false } )
		).toBeVisible();
		expect(
			screen.queryByText( 'This conversation is over two hours old.', { exact: false } )
		).not.toBeInTheDocument();

		( useOffline as jest.Mock ).mockReturnValue( true );
		rerender( <ContextWrapper selectedSite={ runningSite } /> );
		expect( screen.getByText( 'The AI assistant requires an internet connection.' ) ).toBeVisible();
		expect(
			screen.queryByText( 'Your limit will reset in 4 days.', { exact: false } )
		).not.toBeInTheDocument();
		expect(
			screen.queryByText( 'This conversation is over two hours old.', { exact: false } )
		).not.toBeInTheDocument();
	} );

	it( 'restores chat input when changing current site', async () => {
		const anotherSite = {
			...runningSite,
			id: 'another-site-id',
			name: 'Another Test Site',
		};

		const { rerender } = render( <ContextWrapper selectedSite={ runningSite } /> );

		// Input should be empty initially
		expect( getInput() ).toHaveValue( '' );

		// Input is updated for the first site
		fireEvent.change( getInput(), { target: { value: 'New message' } } );
		expect( getInput() ).toHaveValue( 'New message' );

		// Changing to second site should reset the input
		rerender( <ContextWrapper selectedSite={ anotherSite } /> );
		expect( getInput() ).toHaveValue( '' );

		// Input is updated for the second site
		fireEvent.change( getInput(), { target: { value: 'Another message' } } );
		expect( getInput() ).toHaveValue( 'Another message' );

		// Changing to the first site should restore the input
		rerender( <ContextWrapper selectedSite={ runningSite } /> );
		expect( getInput() ).toHaveValue( 'New message' );

		// Changing to the second site should restore the input
		rerender( <ContextWrapper selectedSite={ anotherSite } /> );
		expect( getInput() ).toHaveValue( 'Another message' );
	} );
} );
