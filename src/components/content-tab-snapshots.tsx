import { Spinner } from '@wordpress/components';
import { createInterpolateElement } from '@wordpress/element';
import { __, sprintf } from '@wordpress/i18n';
import { Icon, check, external } from '@wordpress/icons';
import { useI18n } from '@wordpress/react-i18n';
import { PropsWithChildren, useEffect } from 'react';
import {
	CLIENT_ID,
	PROTOCOL_PREFIX,
	WP_AUTHORIZE_ENDPOINT,
	SCOPES,
	DEMO_SITE_SIZE_LIMIT_GB,
} from '../constants';
import { useArchiveErrorMessages } from '../hooks/use-archive-error-messages';
import { useArchiveSite } from '../hooks/use-archive-site';
import { useAuth } from '../hooks/use-auth';
import { useExpirationDate } from '../hooks/use-expiration-date';
import { useFormatLocalizedTimestamps } from '../hooks/use-format-localized-timestamps';
import { useOffline } from '../hooks/use-offline';
import { useProgressTimer } from '../hooks/use-progress-timer';
import { useSiteSize } from '../hooks/use-site-size';
import { useSnapshots } from '../hooks/use-snapshots';
import { useUpdateDemoSite } from '../hooks/use-update-demo-site';
import { cx } from '../lib/cx';
import { getIpcApi } from '../lib/get-ipc-api';
import { ArrowIcon } from './arrow-icon';
import { Badge } from './badge';
import Button from './button';
import offlineIcon from './offline-icon';
import ProgressBar from './progress-bar';
import { ScreenshotDemoSite } from './screenshot-demo-site';
import { Tooltip, TooltipProps, DynamicTooltip } from './tooltip';

interface ContentTabSnapshotsProps {
	selectedSite: SiteDetails;
}

function SnapshotRowLoading( { children }: PropsWithChildren ) {
	return (
		<div className="self-stretch px-4 py-3 flex items-center text-xs">
			<div className={ cx( 'flex mr-1.5 w-8/12 items-center text-a8c-gray-70' ) }>
				<Spinner className="!mt-0 !mx-2" />
				{ children }
			</div>
			<div className="w-28 pr-6 text-a8c-gray-70 whitespace-nowrap overflow-hidden truncate flex-1">
				-
			</div>
		</div>
	);
}

function SnapshotRow( {
	snapshot,
	previousSnapshot,
	selectedSite,
}: {
	snapshot: Snapshot;
	previousSnapshot: Snapshot | null;
	selectedSite: SiteDetails;
} ) {
	const { url, date, isDeleting } =
		previousSnapshot && snapshot.isLoading ? previousSnapshot : snapshot;
	const { countDown, isExpired, dateString } = useExpirationDate( date );
	const { deleteSnapshot, fetchSnapshotUsage, snapshotCreationBlocked, removeSnapshot } =
		useSnapshots();
	const { isUploadingSiteId } = useArchiveSite();
	const isUploading = isUploadingSiteId( selectedSite.id );
	const { updateDemoSite, isDemoSiteUpdating } = useUpdateDemoSite();
	const errorMessages = useArchiveErrorMessages();
	const isSiteDemoUpdating = isDemoSiteUpdating( snapshot.atomicSiteId );
	const { formatRelativeTime } = useFormatLocalizedTimestamps();

	const { isOverLimit } = useSiteSize( selectedSite.id );

	const isOffline = useOffline();
	const updateDemoSiteOfflineMessage = __(
		'Updating a demo site requires an internet connection.'
	);
	const deleteDemoSiteOfflineMessage = __(
		'Deleting a demo site requires an internet connection.'
	);
	const getLastUpdateTimeText = () => {
		if ( ! date ) {
			return __( 'Never updated' );
		}
		const timeDistance = formatRelativeTime( new Date( date ).toISOString() );
		return sprintf( __( 'Last updated %s ago.' ), timeDistance );
	};
	const userBlockedMessage = errorMessages.rest_site_creation_blocked;

	const { progress, setProgress } = useProgressTimer( {
		paused: ! isSiteDemoUpdating,
		initialProgress: 5,
		interval: 1500,
		maxValue: 95,
	} );

	useEffect( () => {
		fetchSnapshotUsage();
	}, [ fetchSnapshotUsage ] );

	useEffect( () => {
		if ( isSiteDemoUpdating ) {
			setProgress( 80 );
		}
	}, [ isSiteDemoUpdating, setProgress ] );

	if ( isDeleting ) {
		return <SnapshotRowLoading>{ __( 'Deleting demo site…' ) }</SnapshotRowLoading>;
	}
	const urlWithHTTPS = `https://${ url }`;
	const handleUpdateDemoSite = async () => {
		const dontShowUpdateWarning = localStorage.getItem( 'dontShowUpdateWarning' );

		if ( ! dontShowUpdateWarning ) {
			const UPDATE_BUTTON_INDEX = 0;
			const CANCEL_BUTTON_INDEX = 1;

			const { response, checkboxChecked } = await getIpcApi().showMessageBox( {
				type: 'info',
				message: __( 'Overwrite demo site' ),
				detail: __(
					"Updating will replace the existing files and database with a copy from your local site. Any changes you've made to your demo site will be permanently lost."
				),
				buttons: [ __( 'Update' ), __( 'Cancel' ) ],
				cancelId: CANCEL_BUTTON_INDEX,
				checkboxLabel: __( "Don't show this warning again" ),
				checkboxChecked: false,
			} );

			if ( response === UPDATE_BUTTON_INDEX ) {
				if ( checkboxChecked ) {
					localStorage.setItem( 'dontShowUpdateWarning', 'true' );
				}

				updateDemoSite( snapshot, selectedSite );
			}
		} else {
			updateDemoSite( snapshot, selectedSite );
		}
	};
	if ( isExpired ) {
		return (
			<div className="self-stretch flex-col">
				<div
					className={ cx(
						'px-4 pt-3',
						'bg-a8c-gray-0 pb-4 border-b border-a8c-gray-5',
						'[&_.demo-site-name]:text-a8c-gray-50',
						'[&_.badge]:text-a8c-gray-50 [&_.badge]:bg-a8c-gray-5'
					) }
				>
					<div className="flex gap-2 items-center">
						<div className="text-black a8c-subtitle-small demo-site-name">
							{ selectedSite.name }
						</div>
						<Badge>{ __( 'Demo site' ) }</Badge>
					</div>
					<Button
						variant="link"
						className={ cx( 'mt-1 !p-0 h-auto', '[&.is-link]:disabled:line-through' ) }
						disabled
					>
						{ urlWithHTTPS }
					</Button>
				</div>
				<div className="px-4 mt-4">
					<div className="text-black a8c-subtitle-small demo-site-name">
						{ sprintf( __( 'Site expired on %s' ), dateString ) }
					</div>
					<div className="a8c-body mt-1">
						{ __( 'Demo sites are deleted 7 days after they were last updated.' ) }
					</div>
				</div>
				<div className="px-4 pb-3 mt-4 flex gap-4">
					<AddDemoSiteWithProgress
						selectedSite={ selectedSite }
						isSnapshotLoading={ snapshot.isLoading }
						tagline={ __( "We're creating your new demo site." ) }
					/>
					{ ! snapshot.isLoading && ! isUploading && (
						<Button isDestructive onClick={ () => removeSnapshot( snapshot ) }>
							{ __( 'Clear expired site' ) }
						</Button>
					) }
				</div>
			</div>
		);
	}

	let tooltipContent: Partial< TooltipProps & { text?: string } > = {};
	if ( isOffline ) {
		tooltipContent = {
			icon: offlineIcon,
			text: updateDemoSiteOfflineMessage,
		};
	} else if ( snapshotCreationBlocked ) {
		tooltipContent = { text: userBlockedMessage };
	} else if ( isOverLimit ) {
		tooltipContent = {
			text: sprintf(
				__(
					'Your site exceeds %s GB in size. Updating this demo site may take considerable amount of time and could exceed the maximum allowed size for a demo site.'
				),
				DEMO_SITE_SIZE_LIMIT_GB
			),
		};
	}
	const isUpdateDisabled = isOffline || snapshotCreationBlocked;

	return (
		<div className="self-stretch flex-col px-4 py-3">
			<div className="flex gap-2 items-center">
				<div className="text-black a8c-subtitle-small demo-site-name line-clamp-1 break-all">
					{ selectedSite.name }
				</div>
				<Badge>{ __( 'Demo site' ) }</Badge>
			</div>
			<Button
				variant="link"
				className="!text-a8c-gray-70 hover:!text-a8c-blueberry max-w-[100%]"
				onClick={ () => {
					getIpcApi().openURL( urlWithHTTPS );
				} }
			>
				<span className="truncate">{ urlWithHTTPS }</span>
				<ArrowIcon />
			</Button>
			<div className="mt-2 text-a8c-gray-70 whitespace-nowrap overflow-hidden truncate flex-1">
				{ sprintf( __( 'Expires in %s' ), countDown ) }
			</div>
			<div className="mt-4 flex gap-4">
				{ isSiteDemoUpdating ? (
					<div className="w-[300px]">
						<ProgressBar value={ progress } maxValue={ 100 } />
						<div className="text-a8c-gray-70 a8c-body mt-4">
							{ __( "We're updating your demo site." ) }
						</div>
					</div>
				) : (
					<>
						<Tooltip
							disabled={ ! ( isOverLimit || isUpdateDisabled ) }
							placement="bottom-start"
							{ ...tooltipContent }
						>
							<DynamicTooltip
								getTooltipText={ getLastUpdateTimeText }
								placement="bottom-start"
								disabled={ isUpdateDisabled || isOverLimit }
							>
								<Button
									aria-description={ tooltipContent?.text || '' }
									aria-disabled={ isUpdateDisabled }
									variant="primary"
									onClick={ () => {
										if ( isUpdateDisabled ) {
											return;
										}
										handleUpdateDemoSite();
									} }
								>
									{ __( 'Update demo site' ) }
								</Button>
							</DynamicTooltip>
						</Tooltip>
						<Tooltip
							disabled={ ! isOffline }
							icon={ offlineIcon }
							placement="top-start"
							text={ deleteDemoSiteOfflineMessage }
						>
							<Button
								aria-description={ isOffline ? deleteDemoSiteOfflineMessage : '' }
								aria-disabled={ isOffline }
								variant="secondary"
								isDestructive
								onClick={ async () => {
									if ( isOffline ) {
										return;
									}

									const { response } = await getIpcApi().showMessageBox( {
										type: 'warning',
										message: __( 'Delete demo site' ),
										detail: __(
											'Your demo sites files and database along with all posts, pages, comments and media will be lost.'
										),
										buttons: [ __( 'Delete' ), __( 'Cancel' ) ],
										cancelId: 1,
									} );

									if ( response === 0 ) {
										deleteSnapshot( snapshot );
									}
								} }
							>
								{ __( 'Delete demo site' ) }
							</Button>
						</Tooltip>
					</>
				) }
			</div>
		</div>
	);
}

function EmptyGeneric( {
	children,
	selectedSite,
}: PropsWithChildren< { selectedSite: SiteDetails } > ) {
	const { __ } = useI18n();
	return (
		<div className="p-8 flex justify-between max-w-3xl gap-4">
			<div className="flex flex-col">
				<div className="a8c-subtitle mb-1">{ __( 'Share a demo site' ) }</div>
				<div className="w-[40ch] text-a8c-gray-70 a8c-body">
					{ createInterpolateElement(
						__(
							'Get feedback from anyone, anywhere with a free demo site powered by <a>WordPress.com</a>.'
						),
						{
							a: (
								<Button
									variant="link"
									onClick={ () =>
										getIpcApi().openURL(
											'https://wordpress.com/?utm_source=studio&utm_medium=referral&utm_campaign=demo_sites_onboarding'
										)
									}
								/>
							),
						}
					) }
				</div>
				<div className="mt-6">
					{ [
						__( 'Share a hosted clone of your local site.' ),
						__( 'Push updates to your demo site at any time.' ),
						__( 'Demo sites are deleted 7 days after the last update.' ),
					].map( ( text ) => (
						<div key={ text } className="text-a8c-gray-70 a8c-body flex items-center">
							<Icon className="fill-a8c-blueberry ltr:mr-2 rtl:ml-2 shrink-0" icon={ check } />
							{ text }
						</div>
					) ) }
				</div>
				{ children }
			</div>
			<div className="flex flex-col shrink-0 items-end">
				<ScreenshotDemoSite site={ selectedSite } />
			</div>
		</div>
	);
}

function NoAuth( { selectedSite }: React.ComponentProps< typeof EmptyGeneric > ) {
	const isOffline = useOffline();
	const { __ } = useI18n();
	const { authenticate } = useAuth();
	const offlineMessage = __( 'You’re currently offline.' );

	return (
		<EmptyGeneric selectedSite={ selectedSite }>
			<div className="mt-8">
				<Tooltip disabled={ ! isOffline } icon={ offlineIcon } text={ offlineMessage }>
					<Button
						aria-description={ isOffline ? offlineMessage : '' }
						aria-disabled={ isOffline }
						variant="primary"
						onClick={ () => {
							if ( isOffline ) {
								return;
							}
							authenticate();
						} }
					>
						{ __( 'Log in to WordPress.com' ) }
						<Icon className="ltr:ml-1 rtl:mr-1 rtl:scale-x-[-1]" icon={ external } size={ 21 } />
					</Button>
				</Tooltip>
			</div>
			<div className="mt-3 w-[40ch] text-a8c-gray-70 a8c-body">
				<Tooltip
					disabled={ ! isOffline }
					icon={ offlineIcon }
					text={ offlineMessage }
					placement="bottom-start"
				>
					{ createInterpolateElement(
						__(
							'A WordPress.com account is required to create demo sites. <a>Create a free account</a>'
						),
						{
							a: (
								<Button
									aria-description={ isOffline ? offlineMessage : '' }
									aria-disabled={ isOffline }
									className="!p-0 text-a8c-blueberry hover:opacity-80 h-auto"
									onClick={ () => {
										if ( isOffline ) {
											return;
										}
										const baseURL = 'https://wordpress.com/log-in/link';
										const authURL = encodeURIComponent(
											`${ WP_AUTHORIZE_ENDPOINT }?response_type=token&client_id=${ CLIENT_ID }&redirect_uri=${ PROTOCOL_PREFIX }%3A%2F%2Fauth&scope=${ SCOPES }&from-calypso=1`
										);
										const finalURL = `${ baseURL }?redirect_to=${ authURL }&client_id=${ CLIENT_ID }`;
										getIpcApi().openURL( finalURL );
									} }
								/>
							),
						}
					) }
				</Tooltip>
			</div>
		</EmptyGeneric>
	);
}

function NoSnapshots( {
	selectedSite,
	isSnapshotLoading,
}: React.ComponentProps< typeof EmptyGeneric > & { isSnapshotLoading?: boolean } ) {
	return (
		<EmptyGeneric selectedSite={ selectedSite }>
			<AddDemoSiteWithProgress
				className="mt-8"
				selectedSite={ selectedSite }
				isSnapshotLoading={ isSnapshotLoading }
			/>
		</EmptyGeneric>
	);
}

function AddDemoSiteWithProgress( {
	isSnapshotLoading,
	selectedSite,
	className = '',
	tagline = '',
}: {
	isSnapshotLoading?: boolean;
	selectedSite: SiteDetails;
	className?: string;
	tagline?: string;
} ) {
	const { __, _n } = useI18n();
	const { archiveSite, isUploadingSiteId, isAnySiteArchiving } = useArchiveSite();
	const isUploading = isUploadingSiteId( selectedSite.id );
	const { activeSnapshotCount, snapshotQuota, isLoadingSnapshotUsage, snapshotCreationBlocked } =
		useSnapshots();
	const isLimitUsed = activeSnapshotCount >= snapshotQuota;
	const { isOverLimit } = useSiteSize( selectedSite.id );
	const isOffline = useOffline();
	const { progress, setProgress } = useProgressTimer( {
		paused: ! isUploading && ! isSnapshotLoading,
		initialProgress: 5,
		interval: 1500,
		maxValue: 95,
	} );
	const errorMessages = useArchiveErrorMessages();

	useEffect( () => {
		if ( isSnapshotLoading ) {
			setProgress( 80 );
		}
	}, [ isSnapshotLoading, setProgress ] );

	const isDisabled =
		isAnySiteArchiving ||
		isUploading ||
		isLoadingSnapshotUsage ||
		isLimitUsed ||
		isOffline ||
		snapshotCreationBlocked;
	const siteArchivingMessage = __(
		'A different demo site is being created. Please wait for it to finish before creating another.'
	);
	const allotmentConsumptionMessage = sprintf(
		_n(
			"You've used %s demo site available on your account.",
			"You've used all %s demo sites available on your account.",
			snapshotQuota
		),
		snapshotQuota
	);
	const offlineMessage = __( 'Creating a demo site requires an internet connection.' );
	const overLimitMessage = sprintf(
		__(
			'Your site exceeds %s GB in size. Creating a demo site for a larger site may take considerable amount of time and could exceed the maximum allowed size for a demo site.'
		),
		DEMO_SITE_SIZE_LIMIT_GB
	);

	const userBlockedMessage = errorMessages.rest_site_creation_blocked;

	let tooltipContent;
	if ( isOffline ) {
		tooltipContent = {
			icon: offlineIcon,
			text: offlineMessage,
		};
	} else if ( isLimitUsed ) {
		tooltipContent = { text: allotmentConsumptionMessage };
	} else if ( isAnySiteArchiving ) {
		tooltipContent = { text: siteArchivingMessage };
	} else if ( snapshotCreationBlocked ) {
		tooltipContent = { text: userBlockedMessage };
	} else if ( isOverLimit ) {
		tooltipContent = { text: overLimitMessage };
	}

	return (
		<div className={ className }>
			{ isUploading || isSnapshotLoading ? (
				<div className="w-[300px]">
					<ProgressBar value={ progress } maxValue={ 100 } />
					<div className="text-a8c-gray-70 a8c-body mt-4">
						{ tagline || __( "We're creating your demo site." ) }
					</div>
				</div>
			) : (
				<div className="flex gap-4">
					<Tooltip disabled={ ! tooltipContent } { ...tooltipContent } placement="top-start">
						<Button
							aria-description={ tooltipContent?.text ?? '' }
							aria-disabled={ isDisabled }
							variant="primary"
							onClick={ () => {
								if ( isDisabled ) {
									return;
								}
								archiveSite( selectedSite.id );
							} }
						>
							{ __( 'Add demo site' ) }
						</Button>
					</Tooltip>
				</div>
			) }
		</div>
	);
}

export function ContentTabSnapshots( { selectedSite }: ContentTabSnapshotsProps ) {
	const { snapshots } = useSnapshots();
	const { isAuthenticated } = useAuth();
	if ( ! isAuthenticated ) {
		return <NoAuth selectedSite={ selectedSite } />;
	}

	const snapshotsOnSite = snapshots.filter(
		( snapshot ) => snapshot.localSiteId === selectedSite.id
	);
	const snapshot = snapshotsOnSite[ 0 ] || null;
	const previousSnapshot = snapshotsOnSite[ 1 ] || null;
	if ( ! snapshot || ( snapshotsOnSite.length === 1 && snapshotsOnSite[ 0 ].isLoading ) ) {
		return <NoSnapshots selectedSite={ selectedSite } isSnapshotLoading={ snapshot?.isLoading } />;
	}
	return (
		<div className="p-8">
			<div className="w-full rounded border border-a8c-gray-5">
				<SnapshotRow
					snapshot={ snapshot }
					previousSnapshot={ previousSnapshot }
					selectedSite={ selectedSite }
					key={ snapshot.atomicSiteId }
				/>
			</div>
		</div>
	);
}
