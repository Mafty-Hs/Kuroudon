import { Component, ElementRef, EventEmitter, Input, NgZone, OnDestroy, OnInit, Output, ViewChild } from '@angular/core';
import { ChatMessage } from '@udonarium/chat-message';
import { ImageFile } from '@udonarium/core/file-storage/image-file';
import { ObjectStore } from '@udonarium/core/synchronize-object/object-store';
import { EventSystem, Network } from '@udonarium/core/system';
import { PeerContext } from '@udonarium/core/system/network/peer-context';
import { DiceBot } from '@udonarium/dice-bot';
import { GameCharacter } from '@udonarium/game-character';
import { PeerCursor } from '@udonarium/peer-cursor';
import { TextViewComponent } from 'component/text-view/text-view.component';
import { ChatMessageService } from 'service/chat-message.service';
import { PanelOption, PanelService } from 'service/panel.service';
import { PointerDeviceService } from 'service/pointer-device.service';

import { ContextMenuSeparator, ContextMenuService, ContextMenuAction } from 'service/context-menu.service';
import { GameCharacterSheetComponent } from 'component/game-character-sheet/game-character-sheet.component';

@Component({
  selector: 'chat-input',
  templateUrl: './chat-input.component.html',
  styleUrls: ['./chat-input.component.css']
})
export class ChatInputComponent implements OnInit, OnDestroy {
  @ViewChild('textArea', { static: true }) textAreaElementRef: ElementRef;

  @Input() onlyCharacters: boolean = false;
  @Input() chatTabidentifier: string = '';

  @Input('gameType') _gameType: string = '';
  @Output() gameTypeChange = new EventEmitter<string>();
  get gameType(): string { return this._gameType };
  set gameType(gameType: string) { this._gameType = gameType; this.gameTypeChange.emit(gameType); }

  @Input('sendFrom') _sendFrom: string = this.myPeer ? this.myPeer.identifier : '';
  @Output() sendFromChange = new EventEmitter<string>();
  get sendFrom(): string { return this._sendFrom };
  set sendFrom(sendFrom: string) { this._sendFrom = sendFrom; this.sendFromChange.emit(sendFrom); }

  @Input('sendTo') _sendTo: string = '';
  @Output() sendToChange = new EventEmitter<string>();
  get sendTo(): string { return this._sendTo };
  set sendTo(sendTo: string) { this._sendTo = sendTo; this.sendToChange.emit(sendTo); }

  @Input('text') _text: string = '';
  @Output() textChange = new EventEmitter<string>();
  get text(): string { return this._text };
  set text(text: string) { this._text = text; this.textChange.emit(text); }

  @Output() chat = new EventEmitter<{ text: string, gameType: string, sendFrom: string, sendTo: string }>();

  get isDirect(): boolean { return this.sendTo != null && this.sendTo.length ? true : false }
  gameHelp: string = '';

  isUseFaceIcon: boolean = true;
  character: GameCharacter = null;

  get imageFile(): ImageFile {
    let object = ObjectStore.instance.get(this.sendFrom);
    let image: ImageFile = null;
    if (object instanceof GameCharacter) {
      image = object.imageFile;
      this.character = object;
    } else if (object instanceof PeerCursor) {
      image = object.image;
    }
    return image ? image : ImageFile.Empty;
  }

  private shouldUpdateCharacterList: boolean = true;
  private _gameCharacters: GameCharacter[] = [];
  get gameCharacters(): GameCharacter[] {
    if (this.shouldUpdateCharacterList) {
      this.shouldUpdateCharacterList = false;
      this._gameCharacters = ObjectStore.instance
        .getObjects<GameCharacter>(GameCharacter)
        .filter(character => this.allowsChat(character));
    }
    return this._gameCharacters;
  }

  private writingEventInterval: NodeJS.Timer = null;
  private previousWritingLength: number = 0;
  writingPeers: Map<string, NodeJS.Timer> = new Map();
  writingPeerNames: string[] = [];

  get diceBotInfos() { return DiceBot.diceBotInfos }
  get myPeer(): PeerCursor { return PeerCursor.myCursor; }
  get otherPeers(): PeerCursor[] { return ObjectStore.instance.getObjects(PeerCursor); }

  constructor(
    private ngZone: NgZone,
    public chatMessageService: ChatMessageService,
    private panelService: PanelService,
    private pointerDeviceService: PointerDeviceService,
    private contextMenuService: ContextMenuService
  ) { }

  ngOnInit(): void {
    EventSystem.register(this)
      .on('MESSAGE_ADDED', event => {
        if (event.data.tabIdentifier !== this.chatTabidentifier) return;
        let message = ObjectStore.instance.get<ChatMessage>(event.data.messageIdentifier);
        let sendFrom = message ? message.from : '?';
        if (this.writingPeers.has(sendFrom)) {
          clearTimeout(this.writingPeers.get(sendFrom));
          this.writingPeers.delete(sendFrom);
          this.updateWritingPeerNames();
        }
      })
      .on('UPDATE_GAME_OBJECT', -1000, event => {
        if (event.data.aliasName !== GameCharacter.aliasName) return;
        this.shouldUpdateCharacterList = true;
        if (event.data.identifier !== this.sendFrom) return;
        let gameCharacter = ObjectStore.instance.get<GameCharacter>(event.data.identifier);
        if (gameCharacter && !this.allowsChat(gameCharacter)) {
          if (0 < this.gameCharacters.length && this.onlyCharacters) {
            this.sendFrom = this.gameCharacters[0].identifier;
          } else {
            this.sendFrom = this.myPeer.identifier;
          }
        }
      })
      .on('DISCONNECT_PEER', event => {
        let object = ObjectStore.instance.get(this.sendTo);
        if (object instanceof PeerCursor && object.peerId === event.data.peer) {
          this.sendTo = '';
        }
      })
      .on<string>('WRITING_A_MESSAGE', event => {
        if (event.isSendFromSelf || event.data !== this.chatTabidentifier) return;
        this.ngZone.run(() => {
          if (this.writingPeers.has(event.sendFrom)) clearTimeout(this.writingPeers.get(event.sendFrom));
          this.writingPeers.set(event.sendFrom, setTimeout(() => {
            this.writingPeers.delete(event.sendFrom);
            this.updateWritingPeerNames();
          }, 2000));
          this.updateWritingPeerNames();
        });
      });
  }

  ngOnDestroy() {
    EventSystem.unregister(this);
  }

  private updateWritingPeerNames() {
    this.writingPeerNames = Array.from(this.writingPeers.keys()).map(peerId => {
      let peer = PeerCursor.find(peerId);
      return peer ? peer.name : '';
    });
  }

  onInput() {
    if (this.writingEventInterval === null && this.previousWritingLength <= this.text.length) {
      let sendTo: string = null;
      if (this.isDirect) {
        let object = ObjectStore.instance.get(this.sendTo);
        if (object instanceof PeerCursor) {
          let peer = PeerContext.create(object.peerId);
          if (peer) sendTo = peer.id;
        }
      }
      EventSystem.call('WRITING_A_MESSAGE', this.chatTabidentifier, sendTo);
      this.writingEventInterval = setTimeout(() => {
        this.writingEventInterval = null;
      }, 200);
    }
    this.previousWritingLength = this.text.length;
    this.calcFitHeight();
  }

  sendChat(event: KeyboardEvent) {
    if (event) event.preventDefault();

    if (!this.text.length) return;
    if (event && event.keyCode !== 13) return;

    if (!this.sendFrom.length) this.sendFrom = this.myPeer.identifier;
    this.chat.emit({ text: this.text, gameType: this.gameType, sendFrom: this.sendFrom, sendTo: this.sendTo });

    this.text = '';
    this.previousWritingLength = this.text.length;
    let textArea: HTMLTextAreaElement = this.textAreaElementRef.nativeElement;
    textArea.value = '';
    this.calcFitHeight();
  }

  calcFitHeight() {
    let textArea: HTMLTextAreaElement = this.textAreaElementRef.nativeElement;
    textArea.style.height = '';
    if (textArea.scrollHeight >= textArea.offsetHeight) {
      textArea.style.height = textArea.scrollHeight + 'px';
    }
  }

  loadDiceBot(gameType: string) {
    console.log('onChangeGameType ready');
    DiceBot.getHelpMessage(gameType).then(help => {
      console.log('onChangeGameType done\n' + help);
    });
  }

  showDicebotHelp() {
    DiceBot.getHelpMessage(this.gameType).then(help => {
      let gameName: string = 'ダイスボット';
      for (let diceBotInfo of DiceBot.diceBotInfos) {
        if (diceBotInfo.script === this.gameType) {
          gameName = 'ダイスボット <' + diceBotInfo.game + '> '
        }
      }
      gameName += '使用法';

      let coordinate = this.pointerDeviceService.pointers[0];
      let option: PanelOption = { left: coordinate.x, top: coordinate.y, width: 600, height: 500 };
      let textView = this.panelService.open(TextViewComponent, option);
      textView.title = gameName;
      textView.text = help;
      /*
        '【ダイスボット】チャットにダイス用の文字を入力するとダイスロールが可能\n'
        + '入力例）２ｄ６＋１　攻撃！\n'
        + '出力例）2d6+1　攻撃！\n'
        + '　　　　  diceBot: (2d6) → 7\n'
        + '上記のようにダイス文字の後ろに空白を入れて発言する事も可能。\n'
        + '以下、使用例\n'
        + '　3D6+1>=9 ：3d6+1で目標値9以上かの判定\n'
        + '　1D100<=50 ：D100で50％目標の下方ロールの例\n'
        + '　3U6[5] ：3d6のダイス目が5以上の場合に振り足しして合計する(上方無限)\n'
        + '　3B6 ：3d6のダイス目をバラバラのまま出力する（合計しない）\n'
        + '　10B6>=4 ：10d6を振り4以上のダイス目の個数を数える\n'
        + '　(8/2)D(4+6)<=(5*3)：個数・ダイス・達成値には四則演算も使用可能\n'
        + '　C(10-4*3/2+2)：C(計算式）で計算だけの実行も可能\n'
        + '　choice[a,b,c]：列挙した要素から一つを選択表示。ランダム攻撃対象決定などに\n'
        + '　S3d6 ： 各コマンドの先頭に「S」を付けると他人結果の見えないシークレットロール\n'
        + '　3d6/2 ： ダイス出目を割り算（切り捨て）。切り上げは /2U、四捨五入は /2R。\n'
        + '　D66 ： D66ダイス。順序はゲームに依存。D66N：そのまま、D66S：昇順。\n'
        + '===================================\n'
        + help;
      */
      console.log('onChangeGameType done');
    });
  }

  private allowsChat(gameCharacter: GameCharacter): boolean {
    switch (gameCharacter.location.name) {
      case 'table':
      case this.myPeer.peerId:
        return true;
      case 'graveyard':
        return false;
      default:
        for (const conn of Network.peerContexts) {
          if (conn.isOpen && gameCharacter.location.name === conn.fullstring) {
            return false;
          }
        }
        return true;
    }
  }

  onContextMenu(e: Event) {
    e.stopPropagation();
    e.preventDefault();

    if (!this.pointerDeviceService.isAllowedToOpenContextMenu || !this.character) return;

    let position = this.pointerDeviceService.pointers[0];
    let contextMenuActions: ContextMenuAction[] = [
      { name: '「」を入力', 
        action: () => {
          let textArea: HTMLTextAreaElement = this.textAreaElementRef.nativeElement;
          let text = this.text.trim();
          if (text.slice(0, 1) != '「') text = '「' + text;
          if (text.slice(-1) != '」') text = text + '」';
          this.text = text;
          textArea.value = this.text;
          textArea.selectionStart = this.text.length - 1;
          textArea.selectionEnd = this.text.length - 1;
          textArea.focus();
        }
      }
    ];
    if (this.character) {
      if (!this.isUseFaceIcon || !this.character.faceIcon) {
        contextMenuActions.push(ContextMenuSeparator);
        contextMenuActions.push(
          { name: '画像効果', action: null, subActions: [
            (this.character.isInverse
              ? {
                name: '☑ 反転', action: () => {
                  this.character.isInverse = false;
                  EventSystem.trigger('UPDATE_INVENTORY', null);
                }
              } : {
                name: '☐ 反転', action: () => {
                  this.character.isInverse = true;
                  EventSystem.trigger('UPDATE_INVENTORY', null);
                }
              }),
            (this.character.isHollow
              ? {
                name: '☑ ぼかし', action: () => {
                  this.character.isHollow = false;
                  EventSystem.trigger('UPDATE_INVENTORY', null);
                }
              } : {
                name: '☐ ぼかし', action: () => {
                  this.character.isHollow = true;
                  EventSystem.trigger('UPDATE_INVENTORY', null);
                }
              }),
            (this.character.isBlackPaint
              ? {
                name: '☑ 黒塗り', action: () => {
                  this.character.isBlackPaint = false;
                  EventSystem.trigger('UPDATE_INVENTORY', null);
                }
              } : {
                name: '☐ 黒塗り', action: () => {
                  this.character.isBlackPaint = true;
                  EventSystem.trigger('UPDATE_INVENTORY', null);
                }
              }),
              { name: 'オーラ', action: null, subActions: [{ name: `${this.character.aura == -1 ? '◉' : '○'} なし`, action: () => { this.character.aura = -1; EventSystem.trigger('UPDATE_INVENTORY', null) } }, ContextMenuSeparator].concat(['ブラック', 'ブルー', 'グリーン', 'シアン', 'レッド', 'マゼンタ', 'イエロー', 'ホワイト'].map((color, i) => {  
                return { name: `${this.character.aura == i ? '◉' : '○'} ${color}`, action: () => { this.character.aura = i; EventSystem.trigger('UPDATE_INVENTORY', null) } };
              })) },
            ContextMenuSeparator,
            {
              name: 'リセット', action: () => {
                this.character.isInverse = false;
                this.character.isHollow = false;
                this.character.isBlackPaint = false;
                this.character.aura = -1;
                EventSystem.trigger('UPDATE_INVENTORY', null);
              },
              disabled: !this.character.isInverse && !this.character.isHollow && !this.character.isBlackPaint && this.character.aura == -1
            }
          ]
        });
      } else {
        contextMenuActions.push(ContextMenuSeparator);
        contextMenuActions.push({
          name: '顔アイコンの変更',
          action: null,
          subActions: this.character.faceIcons.map((faceIconImage, i) => {
            return { 
              name: `${this.character.currntIconIndex == i ? '◉' : '○'}`, 
              action: () => { 
                if (this.character.currntIconIndex != i) {
                  this.character.currntIconIndex = i;
                }
              }, 
              default: this.character.currntIconIndex == i,
              icon: faceIconImage
            };
          })
        });
      }
      contextMenuActions.push(ContextMenuSeparator);
      contextMenuActions.push({ name: '詳細を表示', action: () => { this.showDetail(this.character); } })
    }
    this.contextMenuService.open(position, contextMenuActions, this.character.name);
  }

  private showDetail(gameObject: GameCharacter) {
    let coordinate = this.pointerDeviceService.pointers[0];
    let title = 'キャラクターシート';
    if (gameObject.name.length) title += ' - ' + gameObject.name;
    let option: PanelOption = { title: title, left: coordinate.x - 400, top: coordinate.y - 300, width: 800, height: 600 };
    let component = this.panelService.open<GameCharacterSheetComponent>(GameCharacterSheetComponent, option);
    component.tabletopObject = gameObject;
  }

}
