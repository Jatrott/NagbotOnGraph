// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { app, AppConfig } from './app';
import { ActionTypes, Storage, ActivityTypes, BotAdapter, CardFactory, ConversationReference, TurnContext, ConversationState, UserState, StatePropertyAccessor, MessageFactory, InputHints } from 'botbuilder';
import { ConversationManager } from './conversations';
import { User } from './users';
import { LuisApplication, LuisPredictionOptions, LuisRecognizer } from 'botbuilder-ai'
import { OutlookTask } from './officeGraph';
import { generateSecretKey } from './simpleAuth';

// import { BaseDateTimeExtractor } from '@microsoft/recognizers-text-date-time'


type LuisIntents = "None"
    | "Channels_Clear"
    | "Channels_List"
    | "None"
    | "Notification_Off"
    | "Notification_On"
    | "Reminder_Change"
    | "Reminder_Create"
    | "Reminder_Delete"
    | "Reminder_Find"
    | "Reminder.Location"
    | "Timezone_Adust"
    | "Timezone_Query"
    | "Utilities_Help"
    ;

class ConversationStatus {
    oid: string = null;
    tempVerficationKey: string = null;
}

export interface NagBotConfig {
    store: Storage;
    conversationManager: ConversationManager;
}

export class NagBot {
    private userState: UserState;
    private userAccessor: StatePropertyAccessor<User>;
    private conversationState: ConversationState;
    private conversationAccessor: StatePropertyAccessor<ConversationStatus>;

    private store: Storage;
    private conversationManager: ConversationManager;

    private model: LuisRecognizer;

    constructor(config: NagBotConfig) {
        if (!config || !config.store || !config.conversationManager) throw 'Missing config members needed for NagBot constructor';
        this.store = config.store;
        this.conversationManager = config.conversationManager;

        this.conversationState = new ConversationState(this.store);
        this.userState = new UserState(this.store);

        // Map the contents to the required format for `LuisRecognizer`.
        const luisApplication: LuisApplication = {
            applicationId: AppConfig.luisId,
            endpointKey: AppConfig.luisKey
        }

        // Create configuration for LuisRecognizer's runtime behavior.
        const luisPredictionOptions: LuisPredictionOptions = {
            includeAllIntents: true,
            log: true,
            staging: AppConfig.luisStaging,
            // timezoneOffset: 0
        }
        this.model = new LuisRecognizer(luisApplication, luisPredictionOptions);

        // Create the state property accessors for the conversation data and user profile.
        this.conversationAccessor = this.conversationState.createProperty<ConversationStatus>('conversationData');
        this.userAccessor = this.userState.createProperty<User>('userData');
    }

    /**
     * Every conversation turn calls this method.
     * There are no dialogs used, since it's "single turn" processing, meaning a single request and
     * response, with no stateful conversation.
     * @param turnContext A TurnContext instance, containing all the data needed for processing the conversation turn.
     */

    async onTurn(turnContext: TurnContext) {
        // By checking the incoming Activity type, the bot only calls LUIS in appropriate cases.
        console.log(`onTurn started`);
        const activity = turnContext.activity;
        let user = await this.userAccessor.get(turnContext, {});
        let conversation = await this.conversationAccessor.get(turnContext) || new ConversationStatus();

        switch (turnContext.activity.type) {
            case ActivityTypes.Message:
                switch (activity.text.toLowerCase().trim()) {
                    case 'login':
                        if (!('getUserToken' in turnContext.adapter)) throw new Error(`OAuthPrompt.prompt(): not supported for the current adapter.`);
                        // Check to ensure channel supports it
                        let message = MessageFactory.text('Office 365 Login', undefined, InputHints.ExpectingInput);
                        let oauthCardAttachment = CardFactory.oauthCard("AAD-OAUTH", 'title', 'text');
                        message.attachments = [oauthCardAttachment];
                        console.log(`Attachment: ${JSON.stringify(oauthCardAttachment, null, 2)}`);
                        await turnContext.sendActivity(message);
                        return;
                    case 'signin':
                        if (conversation && conversation.oid) {
                            await turnContext.sendActivity('You are already signed in');
                            await turnContext.sendActivity('Logout to switch user');
                            return;
                        }
                        if (turnContext.activity.conversation.isGroup) {
                            await turnContext.sendActivity('No sign in currently allowed in group conversations');
                            return;
                        }

                        conversation.tempVerficationKey = generateSecretKey();
                        this.conversationManager.addUnauthenticatedConversation(conversation.tempVerficationKey, TurnContext.getConversationReference(activity));
                        // await this.conversationAccessor.set(turnContext, conversation);
                        // await this.conversationState.saveChanges(turnContext);

                        let signinCardAttachment = CardFactory.signinCard('Office 365 Login', `${AppConfig.botLoginUrl}?conversationKey=${conversation.tempVerficationKey}`, 'Click below to connect NagBot to your tasks.');

                        if (turnContext.activity.channelId == 'msteams') {
                            // hack to fix teams.
                            signinCardAttachment.content.buttons[0].type = ActionTypes.OpenUrl;
                        }

                        console.log(`Attachment: ${JSON.stringify(signinCardAttachment, null, 2)}`);
                        await turnContext.sendActivity({ attachments: [signinCardAttachment] });
                        return;
                    default:
                        await this.onTurnLuis(turnContext);
                        return;
                }
                break;

            case ActivityTypes.ConversationUpdate:
                if (activity.recipient.id !== turnContext.activity.membersAdded[0].id) {
                    await turnContext.sendActivity('I am NagBot.  Welcome.');
                }
                break;

            case ActivityTypes.Event:
                // TODO Handle OauthCard as login.
                if (activity.name && activity.name === "tokens/response" && activity.value.token) {
                    await turnContext.sendActivity('Got a token');
                    let token = activity.value.token;
                    let result = app.graph.get(token, 'https://graph.microsoft.com/v1.0/me/');
                    await turnContext.sendActivity(`Result: ${JSON.stringify(result, null, 2)}`);
                }
                break;

            default:
                await turnContext.sendActivity(`[${turnContext.activity.type}]-type activity detected. ${JSON.stringify(turnContext, null, 2)}`);
                break;
        }
    }

    async onTurnLuis(turnContext: TurnContext) {
        let user: User = undefined;
        try {
            let results = await this.model.recognize(turnContext);
            user = await this.userAccessor.get(turnContext, {});
            const topIntent = <LuisIntents>LuisRecognizer.topIntent(results);

            switch (topIntent) {
                case 'Channels_Clear':
                    if (user && user.oid) {
                        await app.conversationManager.clear(user.oid);
                        await turnContext.sendActivity('All channels logged out');
                    } else {
                        await turnContext.sendActivity('Login in to clear channels');
                    }
                    break;
                case 'Reminder_Create':
                    if (user && user.oid) {
                        const text = results.entities["Reminder_Text"];
                        const dueEntity = results.entities["datetime"];
                        let dueDateTime = ProcessDateTimeEntity(dueEntity);
                        if (text && dueDateTime) {
                            let task: OutlookTask = { subject: text, dueDateTime: { timeZone: "PST", dateTime: dueDateTime.toISOString() } };
                            let accessToken = await app.authManager.getAccessTokenFromOid(user.oid);
                            let savedTask = await app.graph.insertTask(accessToken, task);
                            if (savedTask && savedTask.id && savedTask.dueDateTime) await turnContext.sendActivity(`Created new task ${savedTask.subject}
    due ${new Date(savedTask.dueDateTime.dateTime).toString()}`);
                        } else {
                            await turnContext.sendActivity('Unable to create reminder - missing subject');
                        }
                    } else {
                        await turnContext.sendActivity('Login in to create reminders');
                    }
                    break;
                case 'Reminder_Find':
                    if (user && user.oid) {
                        let accessToken = await app.authManager.getAccessTokenFromOid(user.oid);
                        let tasks = await app.graph.findTasks(accessToken)
                        let tasksList = tasks.reduce((prev, cur) => {
                            return prev + ((prev.length > 0) ? ', ' + cur.subject : cur.subject);
                        }, '');
                        await turnContext.sendActivity(`Tasks: (${tasksList})`);
                    } else {
                        await turnContext.sendActivity('Login in see reminders');
                    }
                    break;
                case 'Utilities_Help':
                    await turnContext.sendActivity(helpMessage);
                    break;
                case 'None':
                default:
                    await turnContext.sendActivity(`Unknown intent ${topIntent}`);
                    break;
            }

        } catch (err) {
            console.log(`Error in onTurnLuis at ${new Date(Date.now()).toString()} ${err}`);
            console.log(`User ${user && user.email} has token that expires ${user.authTokens.expiresOn.toString()}`);
        }
    }

    async getUser(turnContext: TurnContext) {
        return await this.userAccessor.get(turnContext);
    }

    async setUser(turnContext: TurnContext, user: User) {
        await this.userAccessor.set(turnContext, user);
        await this.userState.saveChanges(turnContext);
    }
}

const helpMessage = `I am NagBot.

You can ask me to do any of the following:
* Clear channels
* Create a reminder; e.g. remind me to walk the dog tomorrow noon
* List reminders: what are my reminders?`;

function ProcessDateTimeEntity(dateEntity: { type: string, timex: string[] }[]) {
    // "https://github.com/Microsoft/Recognizers-Text/blob/master/JavaScript/packages/recognizers-date-time/src/dateTime/constants.ts"
    // "https://github.com/Microsoft/Recognizers-Text/blob/master/JavaScript/samples/botbuilder/index.js"

    if (dateEntity.length < 1 && dateEntity[0].type && dateEntity[0].timex.length < 1) return undefined;

    var first = dateEntity[0];
    var type = first.type
    var firstTimex = first.timex[0];

    let date, time;
    if (firstTimex.includes('T')) {
        [date, time] = firstTimex.split('T');
    } else if (firstTimex.includes('-')) {
        date = firstTimex;
    } else {
        time = firstTimex;
    }
    if (!time) time = "00:00";
    if (!date || !date.includes('-')) date = new Date(Date.now()).toISOString().split('T')[0];
    let [hours, mins] = time.split(':');
    if (!mins) time += ":00";
    let dateTime = date + 'T' + time;
    let result = new Date(date + 'T' + time);
    console.log(`found DateTime ${dateTime} as ${result.toString()}`);
    return result;
}

